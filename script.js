/* ============================================================
   БИЛЕТИК — интерактивная открытка-приглашение
   Архитектурно переписанная версия с исправлениями анимаций,
   утечек памяти, race conditions и производительности.
   ============================================================ */

'use strict';

/* ============ УТИЛИТЫ И КОНСТАНТЫ ============ */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);
const raf = requestAnimationFrame.bind(window);
const caf = cancelAnimationFrame.bind(window);

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Debounce для resize
function debounce(fn, delay = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), delay);
  };
}

// Throttle для pointermove
function throttle(fn, limit = 16) {
  let last = 0, timer = null, lastArgs = null;
  return function(...args) {
    const now = performance.now();
    lastArgs = args;
    if (now - last >= limit) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = performance.now();
        timer = null;
        fn.apply(this, lastArgs);
      }, limit - (now - last));
    }
  };
}

// Проверка WebGL
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (e) { return false; }
}

if (!hasWebGL()) document.body.classList.add('no-webgl');

/* ============ WEBGL: ФОН ============ */
const BG_FRAG = `precision mediump float;
uniform vec2 uR;uniform float uT;uniform vec2 uP;uniform float uDim;
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);
 float a=h21(i),b=h21(i+vec2(1,0)),c=h21(i+vec2(0,1)),d=h21(i+vec2(1,1));
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<4;i++){v+=a*vn(p);p*=2.03;a*=0.55;}return v;}
void main(){
 vec2 uv=(gl_FragCoord.xy-0.5*uR)/uR.y;
 vec2 q=uv+uP*0.06;
 float t=uT*0.016;
 float f1=fbm(q*1.7+vec2(t,-t*0.7));
 float f2=fbm(q*2.6-vec2(t*0.8,t*0.5)+f1*1.2);
 vec3 col=vec3(0.043,0.063,0.125);
 col=mix(col,vec3(0.13,0.09,0.16),smoothstep(0.3,0.8,f1)*0.55);
 col=mix(col,vec3(0.94,0.71,0.29),smoothstep(0.55,0.92,f2)*0.14);
 col=mix(col,vec3(0.95,0.44,0.38),smoothstep(0.6,0.95,fbm(q*2.2+vec2(-t*0.6,t*0.4)))*0.10);
 col=mix(col,vec3(0.45,0.8,0.68),smoothstep(0.7,0.98,f1*f2*1.8)*0.08);
 vec2 sp=gl_FragCoord.xy/(uR.y/90.0);vec2 id=floor(sp);vec2 gv=fract(sp)-0.5;
 float rnd=h21(id);
 vec2 off=vec2(h21(id+3.1),h21(id+7.7))-0.5;
 float star=smoothstep(0.14,0.02,length(gv-off*0.7))*step(0.93,rnd);
 float twk=0.4+0.6*sin(uT*(0.6+rnd*2.0)+rnd*40.0);
 col+=vec3(1.0,0.93,0.78)*star*twk*0.7;
 col*=1.0-uDim*0.55;
 gl_FragColor=vec4(col,1.0);
}`;

const HOLO_FRAG = `precision mediump float;
uniform vec2 uR;uniform float uT;uniform float uRy;uniform float uRx;uniform vec2 uP;uniform float uB;
vec3 pal(float t){return 0.5+0.5*cos(6.28318*(t+vec3(0.0,0.33,0.67)));}
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
void main(){
 vec2 uv=gl_FragCoord.xy/uR;
 float ry=uRy*0.0174533;
 float w1=sin((uv.x*7.0+uv.y*2.0)+ry*3.0+uP.x*1.5);
 float w2=sin((uv.y*6.0-uv.x*1.5)+ry*1.7+uRx*0.05+uP.y*1.5);
 float m=w1*0.6+w2*0.4;
 vec3 foil=pal(m*0.45+uT*0.03);
 float sheen=pow(clamp(1.0-abs(m),0.0,1.0),2.0);
 vec2 cell=floor(gl_FragCoord.xy/4.0);
 float spark=step(0.992,h21(cell+floor(uT*10.0)))*(0.4+0.6*sheen);
 vec3 col=foil*(0.22+0.5*sheen)+vec3(1.0)*(spark*0.7+uB*0.3);
 float a=0.16+0.55*sheen+spark*0.3+uB*0.4;
 gl_FragColor=vec4(col*a,a);
}`;

/* Создание и управление WebGL-контекстом с обработкой потери контекста */
function makeGL(canvas, fragSrc, alpha) {
  try {
    const opts = { alpha: !!alpha, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) return null;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw err;
      }
      return sh;
    };

    const buildProgram = () => {
      const pr = gl.createProgram();
      gl.attachShader(pr, compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
      gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw gl.getProgramInfoLog(pr);
      gl.useProgram(pr);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      return pr;
    };

    let pr = buildProgram();

    const api = {
      gl,
      canvas,
      lost: false,
      pr: () => pr,
      U: (n) => gl.getUniformLocation(pr, n),
      resize() {
        if (api.lost) return;
        const d = Math.min(2, devicePixelRatio || 1);
        const w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
        if (!w || !h) return;
        if (canvas.width !== w * d || canvas.height !== h * d) {
          canvas.width = w * d;
          canvas.height = h * d;
          gl.viewport(0, 0, canvas.width, canvas.height);
        }
      },
      destroy() {
        api.lost = true;
        if (pr) { gl.deleteProgram(pr); pr = null; }
      }
    };

    // Обработка потери контекста
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      api.lost = true;
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      try { pr = buildProgram(); api.lost = false; } catch (e) {}
    }, false);

    return api;
  } catch (e) {
    console.warn('WebGL init failed:', e);
    return null;
  }
}

/* ============ WEB AUDIO (throttled) ============ */
const Audio = (() => {
  let AC = null, NB = null, muted = false;
  const lastSound = new Map();
  const THROTTLE_MS = 80;

  function ac() {
    if (muted) return null;
    if (!AC) {
      try { AC = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (AC.state === 'suspended') AC.resume().catch(() => {});
    return AC;
  }

  function nbuf(c) {
    if (!NB) {
      NB = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = NB.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return NB;
  }

  const play = (name, fn) => {
    const now = performance.now();
    if (lastSound.get(name) && now - lastSound.get(name) < THROTTLE_MS) return;
    lastSound.set(name, now);
    const c = ac();
    if (!c) return;
    try { fn(c); } catch (e) {}
  };

  const pNoise = (c, { dur = .3, f = 800, f2, q = 1, gain = .4, type = 'bandpass' } = {}) => {
    const s = c.createBufferSource(); s.buffer = nbuf(c); s.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type;
    fl.frequency.setValueAtTime(f, c.currentTime);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, c.currentTime + dur);
    fl.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, c.currentTime + dur);
    s.connect(fl).connect(g).connect(c.destination);
    s.start();
    s.stop(c.currentTime + dur + .05);
  };

  const pTone = (c, { f = 440, dur = .25, gain = .25, type = 'sine', when = 0, f2 } = {}) => {
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f, c.currentTime + when);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, c.currentTime + when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(.0001, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + when + .02);
    g.gain.exponentialRampToValueAtTime(.001, c.currentTime + when + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + when);
    o.stop(c.currentTime + when + dur + .05);
  };

  return {
    play(name) {
      if (muted) return;
      switch (name) {
        case 'grab': play('grab', c => pTone(c, { f: 160, dur: .06, gain: .08 })); break;
        case 'crack': play('crack', c => pNoise(c, { dur: .09, f: 2600, q: 2, gain: .25 })); break;
        case 'seal': play('seal', c => { pNoise(c, { dur: .28, f: 1000, f2: 250, gain: .5 }); pTone(c, { f: 90, dur: .22, gain: .4 }); }); break;
        case 'flap': play('flap', c => pNoise(c, { dur: .4, f: 600, f2: 180, gain: .3, type: 'lowpass' })); break;
        case 'pull': play('pull', c => pNoise(c, { dur: .3, f: 1400, f2: 700, gain: .25 })); break;
        case 'tear': play('tear', c => pNoise(c, { dur: .5, f: 2000, f2: 300, q: .8, gain: .5 })); break;
        case 'stamp': play('stamp', c => { pTone(c, { f: 70, dur: .25, gain: .6 }); pNoise(c, { dur: .07, f: 3200, gain: .3 }); }); break;
        case 'yay': play('yay', c => [523, 659, 784, 1046].forEach((f, i) => pTone(c, { f, dur: .3, gain: .2, when: i * .11 }))); break;
      }
    },
    toggle() {
      muted = !muted;
      return muted;
    },
    isMuted: () => muted
  };
})();

// Активация Audio по первому взаимодействию
const initAudio = () => {
  try {
    const AC = new (window.AudioContext || window.webkitAudioContext)();
    AC.resume().catch(() => {});
  } catch (e) {}
};
document.addEventListener('pointerdown', initAudio, { once: true });
document.addEventListener('keydown', initAudio, { once: true });

/* ============ ГЛОБАЛЬНОЕ СОСТОЯНИЕ ============ */
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
let dim = 0;
let mainRAF = null;
let masterLoopRunning = true;

const card = { oc: null, to: '', from: '', msg: '', mode: 'choice', dates: [], times: [], places: [], date: '', time: '', place: '', no: '' };
let step = 0;
let previewMode = false;
let confirmed = false;
let dragApi = null;
let holo = null;
let R = { stage: 'seal' };
let curView = 'v-home';

const freshCard = () => ({
  oc: null, to: '', from: '', msg: '', mode: 'choice',
  dates: [], times: [], places: [],
  date: '', time: '', place: '',
  no: String(100000 + Math.floor(Math.random() * 899999))
});
card.no = freshCard().no;

/* ============ ДАННЫЕ ============ */
const ICONS = {
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/></svg>',
  teatr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V7a8 8 0 0 1 16 0v13"/><path d="M12 7c0 5-2.2 8.6-5 13M12 7c0 5 2.2 8.6 5 13"/><path d="M2.5 20h19"/></svg>',
  park: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="10" r="6"/><path d="M12 4v12M6.8 7l10.4 6M17.2 7 6.8 13M9 21l3-5 3 5"/></svg>',
  kafe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 10h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 11h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8.5 6c0-1 .8-1.2.8-2.3M12 6c0-1 .8-1.2.8-2.3"/></svg>',
  koncert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 18V6l8-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="14.5" cy="16" r="2.5"/></svg>',
  syurpriz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 4l1.7 4.6L18.3 10l-4.6 1.7L12 16.3l-1.7-4.6L5.7 10l4.6-1.4z"/><path d="M18.6 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>'
};

const OC = {
  kino:    { n: 'Кино',     ticket: 'Кинобилет',          tag: 'сеанс, попкорн и два стаканчика',   c: '#ff5c57', ic: 'film',     def: 'Идём в кино? Попкорн и лучший ряд — с меня.' },
  teatr:   { n: 'Театр',    ticket: 'Театральный билет',  tag: 'партер, антракт и восхищение',      c: '#e8c470', ic: 'teatr',    def: 'Приглашаю тебя в театр. Дресс-код — твои глаза.' },
  park:    { n: 'Парк',     ticket: 'Билет на прогулку',  tag: 'мороженое, карусель и болтовня',    c: '#5fc98a', ic: 'park',     def: 'Давай гулять: мороженое, карусель и разговоры до темна.' },
  kafe:    { n: 'Кафе',     ticket: 'Столик на двоих',    tag: 'десерт, какао и разговоры',         c: '#e2965a', ic: 'kafe',     def: 'Столик у окна, десерт на двоих. Ты со мной?' },
  koncert: { n: 'Концерт',  ticket: 'Билет на концерт',   tag: 'громкая музыка и мурашки',          c: '#ff4f9a', ic: 'koncert',  def: 'Есть два билета на концерт. Второе место — твоё.' },
  syurpriz:{ n: 'Сюрприз',  ticket: 'Билет-загадка',      tag: 'всё секрет — доверься вечеру',      c: '#8fb2ff', ic: 'syurpriz', def: 'Не скажу ни слова. Просто доверься мне в этот вечер.' }
};
const OCK = Object.keys(OC);

const WDA = ['вс','пн','вт','ср','чт','пт','сб'];
const MO = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const fmtD = v => {
  if (!v) return '';
  const p = v.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return `${WDA[d.getDay()]}, ${d.getDate()} ${MO[d.getMonth()]}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ============ HTML БИЛЕТА ============ */
function ticketHTML(c, small) {
  const o = OC[c.oc] || OC.kino;
  const no = c.no || '000143';
  const ch = c.mode === 'choice';
  const when = ch ? 'выберешь сама' : (fmtD(c.date) || 'скоро');
  const time = ch ? 'когда скажешь' : (c.time || '—');
  const place = ch ? 'куда позовёшь' : (c.place || 'сюрприз');
  const ocls = ch ? ' class="opt"' : '';
  return `<div class="ticket t-${c.oc}${small ? ' sz-s' : ''}">
    <div class="tk-body">${c.oc === 'kino' ? '<div class="strip"></div>' : ''}
      <div class="tk-pad">
        <div class="tk-top"><span class="tk-type">${o.ticket}</span><span class="tk-no">№ ${no}</span></div>
        <div class="tk-for">для <span>${esc(c.to || 'тебя')}</span></div>
        <div class="tk-msg">«${esc(c.msg || o.def)}»</div>
        <div class="tk-meta">
          <div><i>когда</i><b${ocls}>${when}</b></div>
          <div><i>во сколько</i><b${ocls}>${time}</b></div>
          <div><i>где</i><b${ocls}>${place}</b></div>
        </div>
      </div>${c.oc === 'kino' ? '<div class="strip s-b"></div>' : ''}
    </div>
    <div class="tk-perf"></div>
    <div class="tk-stub"><div class="ic">${ICONS[o.ic]}</div><div class="tk-fr">от<br>${esc(c.from || 'анонима')}</div><div class="tk-bar"></div></div>
    <div class="tk-glare"></div>
  </div>`;
}

/* ============ WEBGL: ИНИЦИАЛИЗАЦИЯ ============ */
let bgGL = null;
let bgU = null;

if (hasWebGL()) {
  bgGL = makeGL($('glbg'), BG_FRAG, false);
  if (bgGL) {
    document.body.classList.add('gl-on');
    bgGL.resize();
    bgU = { R: bgGL.U('uR'), T: bgGL.U('uT'), P: bgGL.U('uP'), D: bgGL.U('uDim') };
  }
}

/* ============ MOUSE/TOUCH TRACKING ============ */
const updateMouse = throttle((e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return; // фон не дёргается от пальца
  mouse.x = e.clientX / innerWidth * 2 - 1;
  mouse.y = e.clientY / innerHeight * 2 - 1;
}, 16);
document.addEventListener('pointermove', updateMouse, { passive: true });

/* ============ TILT-EFFECT ДЛЯ БИЛЕТОВ (throttled) ============ */
const handleTicketTilt = throttle((e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return; // наклон — только мышь
  const t = e.target.closest('.ticket');
  if (!t || t.classList.contains('has-holo')) return;
  const r = t.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  t.style.setProperty('--lx', (px * 100) + '%');
  t.style.setProperty('--ly', (py * 100) + '%');
  t.style.setProperty('--ry', ((px - .5) * 9) + 'deg');
  t.style.setProperty('--rx', ((.5 - py) * 9) + 'deg');
}, 16);
document.addEventListener('pointermove', handleTicketTilt, { passive: true });

document.addEventListener('pointerout', (e) => {
  const t = e.target.closest('.ticket');
  if (t && !t.contains(e.relatedTarget)) {
    t.style.setProperty('--rx', '0deg');
    t.style.setProperty('--ry', '0deg');
  }
});

/* ============ ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ ============ */
(() => {
  // Бегущая строка
  const words = OCK.map(k => `<span>${OC[k].n.toUpperCase()} <i>✦</i></span>`).join('');
  $('marqIn').innerHTML = words + words + words;

  // Веер билетов на главной
  const fan = $('fan');
  fan.innerHTML = [['teatr','Анна','Миша'], ['kino','Аня','он'], ['park','Лиза','К.']].map((s, i) => {
    const oc = ['teatr','kino','park'][i];
    return `<div class="fan-slot fs${i+1}">${ticketHTML({ oc, to: s[1], from: s[2], msg: OC[oc].def, no: String(240100 + i * 77) }, true)}</div>`;
  }).join('');

  const handleFanMove = throttle((e) => {
    const r = fan.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - .5;
    const y = (e.clientY - r.top) / r.height - .5;
    fan.style.transform = `rotateY(${x * 7}deg) rotateX(${-y * 6}deg)`;
  }, 32);
  fan.addEventListener('mousemove', handleFanMove, { passive: true });
  fan.addEventListener('mouseleave', () => { fan.style.transform = ''; });

  // Витрина
  const shelf = $('shelf');
  const decos = {
    kino: '<div class="sc-deco"><div class="film-run" style="opacity:.12;top:38%"></div></div>',
    teatr: '<div class="sc-deco"><span class="sc-spark" style="left:14%;top:22%"></span><span class="sc-spark" style="right:18%;top:30%;animation-delay:.5s"></span><span class="sc-spark" style="left:48%;bottom:26%;animation-delay:.9s"></span></div>',
    park: '<div class="sc-deco"><span class="sc-leaf" style="left:18%"></span><span class="sc-leaf" style="left:52%;animation-delay:.9s"></span><span class="sc-leaf" style="left:82%;animation-delay:1.6s"></span></div>',
    kafe: '<div class="sc-deco"><span class="sc-steam" style="left:26%"></span><span class="sc-steam" style="left:48%;animation-delay:.8s"></span><span class="sc-steam" style="left:70%;animation-delay:1.5s"></span></div>',
    koncert: `<div class="sc-deco"><div class="sc-eq">${Array.from({length:18}, (_, i) => `<i style="--d:${i*0.07}s;--h:${30+Math.random()*70}%"></i>`).join('')}</div></div>`,
    syurpriz: '<div class="sc-deco"><span class="sc-spark" style="left:20%;top:20%"></span><span class="sc-spark" style="right:14%;top:44%;animation-delay:.4s"></span><span class="sc-spark" style="left:40%;bottom:16%;animation-delay:.8s"></span><span class="sc-spark" style="right:30%;bottom:30%;animation-delay:1.2s"></span></div>'
  };
  const notes = {
    kino: 'лента крутится, свет гаснет',
    teatr: 'золото и бархат',
    park: 'листопад на билете',
    kafe: 'пар над чашкой',
    koncert: 'басы уже качают',
    syurpriz: 'что там? узнает она'
  };
  shelf.innerHTML = OCK.map(k => `<div class="shelf-card sc-${k}" style="--sc:${OC[k].c}">${decos[k]}${ticketHTML({ oc: k, to: 'неё', from: 'него', msg: OC[k].def, no: '100' + (200 + OCK.indexOf(k) * 13) })}<div class="sc-cap"><b>${OC[k].n}</b><span>${notes[k]}</span></div></div>`).join('');

  // Карточки повода
  $('ocGrid').innerHTML = OCK.map(k => `<button class="oc-card" type="button" data-oc="${k}" style="--c:${OC[k].c}" role="radio" aria-checked="false">
    <span class="oc-check" aria-hidden="true">✓</span>
    <span class="oc-ic">${ICONS[OC[k].ic]}</span>
    <h3>${OC[k].n}</h3>
    <p>${OC[k].tag}</p>
  </button>`).join('');
})();

/* ============ INTERSECTION OBSERVER (с очисткой) ============ */
let revealObserver = null;

function initRevealObserver() {
  if (revealObserver) revealObserver.disconnect();
  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        revealObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.14 });
  $$('.reveal').forEach(el => {
    if (!el.classList.contains('in')) revealObserver.observe(el);
  });
}
initRevealObserver();

/* ============ НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ ============ */
function setZen(on) {
  document.body.classList.toggle('zen', on);
  if (!on) document.body.classList.remove('preview');
}

function show(id) {
  if (curView === id) return;
  const a = $(curView), b = $(id);
  a.classList.add('out');
  setTimeout(() => {
    a.classList.remove('active', 'out');
    b.classList.add('active');
    curView = id;
    window.scrollTo({ top: 0, behavior: 'auto' });
    enter(id);
  }, 350);
}

function enter(id) {
  if (id === 'v-card' || id === 'v-reply') {
    setZen(true);
    document.body.classList.toggle('preview', previewMode);
  } else {
    setZen(false);
  }
  if (id === 'v-create') {
    setAccent();
    renderPreview();
    renderChips();
  }
  if (id === 'v-card') {
    startRecipient();
  }
  if (id === 'v-home') {
    initRevealObserver();
  }
}

// Глобальный сброс grab-состояний (fix для залипания)
document.addEventListener('pointerup', () => {
  $$('.grab').forEach(el => el.classList.remove('grab'));
});
document.addEventListener('pointercancel', () => {
  $$('.grab').forEach(el => el.classList.remove('grab'));
});

document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (!g) return;
  if (g.dataset.go === 'create') {
    Object.assign(card, card.oc ? {} : freshCard());
    goStep(0);
    show('v-create');
  } else {
    show('v-home');
  }
});

$('zenExit').addEventListener('click', () => {
  previewMode = false;
  setZen(false);
  show('v-create');
});

/* ============ КОНСТРУКТОР ============ */
$('ocGrid').addEventListener('click', (e) => {
  const b = e.target.closest('.oc-card');
  if (!b) return;
  $$('.oc-card').forEach(x => {
    x.classList.remove('on');
    x.setAttribute('aria-checked', 'false');
  });
  b.classList.add('on');
  b.setAttribute('aria-checked', 'true');
  card.oc = b.dataset.oc;
  setAccent();
  renderPreview(true);
  burst(e.clientX, e.clientY, { n: 14, colors: [OC[card.oc].c, '#f0b64b', '#fff'], pow: 6 });
  setTimeout(() => { if (step === 0) goStep(1); }, 450);
});

function setAccent() {
  $('v-create').style.setProperty('--acc', card.oc ? OC[card.oc].c : '#f0b64b');
}

function goStep(i) {
  step = i;
  $('track').style.transform = `translateX(-${i * (100/3)}%)`;
  $$('#crSteps .cr-dot').forEach((d, idx) => {
    d.classList.toggle('on', idx === i);
    d.classList.toggle('done', idx < i);
  });
  if (i === 2) buildDone();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-step]').forEach(b => b.addEventListener('click', () => goStep(+b.dataset.step)));

$('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  $$('#modeSeg button').forEach(x => {
    x.classList.remove('on');
    x.setAttribute('aria-checked', 'false');
  });
  b.classList.add('on');
  b.setAttribute('aria-checked', 'true');
  card.mode = b.dataset.mode;
  $('choiceBox').style.display = card.mode === 'choice' ? '' : 'none';
  $('fixedBox').style.display = card.mode === 'fixed' ? '' : 'none';
  renderPreview(true);
});

['fTo','fFrom','fMsg','fDate','fTime','fPlace'].forEach(id => {
  $(id).addEventListener('input', (e) => {
    const m = { fTo:'to', fFrom:'from', fMsg:'msg', fDate:'date', fTime:'time', fPlace:'place' }[id];
    card[m] = e.target.value;
    renderPreview();
  });
});

function renderChips() {
  const map = { dates: $('chDates'), times: $('chTimes'), places: $('chPlaces') };
  for (const k in map) {
    map[k].innerHTML = card[k].map((v, i) =>
      `<button class="chip" type="button" data-rm="${k}:${i}" role="listitem">${k === 'dates' ? fmtD(v) : esc(v)} <span class="x" aria-hidden="true">✕</span></button>`
    ).join('');
  }
}

$$('.btn-mini').forEach(b => b.addEventListener('click', (e) => {
  const k = b.dataset.add;
  const inp = $({ dates:'inDate', times:'inTime', places:'inPlace' }[k]);
  const v = inp.value.trim();
  if (!v) {
    inp.classList.add('need');
    setTimeout(() => inp.classList.remove('need'), 500);
    return;
  }
  if (!card[k].includes(v) && card[k].length < 6) {
    card[k].push(v);
    renderChips();
    renderPreview(true);
    burst(e.clientX, e.clientY, { n: 10, colors: [OC[card.oc]?.c || '#f0b64b', '#fff'], pow: 5 });
  }
  inp.value = '';
}));

document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (!rm) return;
  const [k, i] = rm.dataset.rm.split(':');
  card[k].splice(+i, 1);
  renderChips();
  renderPreview();
});

function renderPreview(shine) {
  const slot = $('pvSlot');
  if (!card.oc) {
    slot.innerHTML = '<p style="font:600 20px Caveat;color:var(--mut)">сначала выбери повод ←</p>';
    return;
  }
  slot.innerHTML = ticketHTML(card);
  if (shine) {
    const t = slot.querySelector('.ticket');
    t.classList.add('shine');
    setTimeout(() => t.classList.remove('shine'), 1200);
  }
}

$('toStep3').addEventListener('click', () => {
  if (!card.oc) { goStep(0); return; }
  if (!card.to.trim()) {
    const f = $('fTo');
    f.classList.add('need');
    f.focus();
    setTimeout(() => f.classList.remove('need'), 600);
    return;
  }
  goStep(2);
});

/* ============ ССЫЛКА И ШЕРИНГ ============ */
const enc = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
function baseHref() {
  try {
    return (location.origin === 'null' ? 'index.html' : location.href.split('#')[0]);
  } catch (e) { return 'index.html'; }
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;top:-40px;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function buildDone() {
  const code = enc(card);
  $('linkOut').value = baseHref() + '#/k/' + code;
  $('s3Ticket').innerHTML = ticketHTML(card);
  burst(innerWidth / 2, innerHeight * 0.3, {
    n: 60,
    colors: [OC[card.oc].c, '#f0b64b', '#ff6f61', '#fff'],
    pow: 9,
    shapes: ['r','c','h']
  });
}

$('copyBtn').addEventListener('click', async (e) => {
  const ok = await copyText($('linkOut').value);
  e.target.textContent = ok ? 'Скопировано ✓' : 'выдели и скопируй';
  setTimeout(() => { e.target.textContent = 'Копировать'; }, 1600);
  burst(e.clientX, e.clientY, { n: 18, colors: ['#7ad0b2', '#f0b64b'], pow: 6 });
});

$('openAsHer').addEventListener('click', () => {
  previewMode = true;
  show('v-card');
});

$('anew').addEventListener('click', () => {
  Object.assign(card, freshCard());
  ['fTo','fFrom','fMsg','fDate','fTime','fPlace','inDate','inTime','inPlace'].forEach(id => $(id).value = '');
  $$('.oc-card').forEach(x => {
    x.classList.remove('on');
    x.setAttribute('aria-checked', 'false');
  });
  setAccent();
  renderChips();
  renderPreview();
  goStep(0);
});

$$('[data-demo]').forEach(b => b.addEventListener('click', () => {
  Object.assign(card, {
    oc: 'kino', to: 'Аня', from: 'Миша',
    msg: 'Говорят, в «Октябре» идёт тот самый фильм. Идём?',
    mode: 'choice',
    dates: ['2026-08-14','2026-08-15','2026-08-16'],
    times: ['19:00','21:30'],
    places: ['Кинотеатр «Октябрь»', '«Художественный»'],
    no: '240214'
  });
  previewMode = true;
  show('v-card');
}));

/* ============ ПОЛУЧАТЕЛЬ: ОБЩИЙ КОД ============ */
const HINT = {
  seal: 'зажми пломбу и потяни… ✉',
  flap: 'пломба сорвана! подними клапан ↑',
  pull: 'теперь вытащи билет ↑'
};
function setHint(t) { $('rHint').textContent = t; }

function resetEnv() {
  R = { stage: 'seal' };
  confirmed = false;
  dragApi = null;
  if (holo) { try { holo.g.destroy(); } catch (e) {} holo = null; }

  const env = $('env'), seal = $('seal'), flap = $('envFlap'), inn = $('envIn');
  env.classList.remove('open');
  seal.classList.remove('gone', 'press');
  seal.style.cssText = '';
  flap.classList.remove('ready');
  flap.style.cssText = '';
  inn.classList.remove('peek');
  inn.style.cssText = '';
  $('envFloat').classList.remove('kaboom');
  $('envFloat').style.cssText = '';
  $('envFloat').querySelectorAll('.seal-half,.shard,.shock,.seal-burst').forEach(n => n.remove());
  $('sealGlow').style.opacity = 0;
  seal.querySelectorAll('.crack').forEach(c => {
    c.style.opacity = 0;
    c.style.strokeDashoffset = 1;
  });
  setHint(HINT.seal);
}

function startRecipient() {
  resetEnv();
  $('envIn').innerHTML = ticketHTML(card);
  $('envAddr').textContent = card.to || 'для тебя';
  $('rCap').classList.remove('show');
  $('dragHint').classList.remove('show');
  $('noteFly').classList.remove('show', 'hide');
  $('flip').classList.remove('back-live');
  rstage('rsEnv');
}

function rstage(id) {
  $$('.rstage').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo({ top: 0 });
}

/* ============ ЖЕСТ 1: ПЛОМБА ============ */
(() => {
  const seal = $('seal'), glow = $('sealGlow');
  let dr = null, torn = false, lastFlake = 0;

  const setP = (p) => {
    seal.querySelectorAll('.crack').forEach((c, i) => {
      const lp = Math.max(0, Math.min(1, p * 3 - i));
      c.style.opacity = lp > 0 ? 1 : 0;
      c.style.strokeDashoffset = 1 - lp;
    });
    glow.style.opacity = p * .95;
    if (p > 0) $('envFloat').style.transform = `rotate(${(Math.random() - .5) * p * 2}deg)`;
  };

  seal.addEventListener('pointerdown', (e) => {
    if (R.stage !== 'seal') return;
    e.preventDefault();
    seal.setPointerCapture(e.pointerId);
    seal.classList.add('press');
    dr = { x: e.clientX, y: e.clientY };
    torn = false;
    lastFlake = 0;
    Audio.play('grab');
  });

  const onMove = throttle((e) => {
    if (!dr || R.stage !== 'seal') return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    const d = Math.hypot(dx, dy), p = Math.min(1, d / (IS_TOUCH ? 90 : 110));
    seal.style.transform = `translate(-50%,-50%) translate(${dx * .45}px,${dy * .45}px) rotate(${dx * .12}deg) rotateY(${dx * .15}deg) rotateX(${-dy * .15}deg) scale(${1 + p * .07})`;
    setP(p);
    if (p - lastFlake > .12) {
      lastFlake = p;
      const r = seal.getBoundingClientRect();
      burst(r.left + r.width / 2 + (Math.random() * 44 - 22), r.top + r.height / 2 + (Math.random() * 44 - 22),
        { n: 3, colors: ['#7c1f2e', '#a13a4a', '#e59aa6'], pow: 3 });
    }
    if (p > .33 && p < .4) Audio.play('crack');
    if (p > .66 && p < .73) Audio.play('crack');
    if (p >= 1) { torn = true; dr = null; seal.classList.remove('press'); tearSeal(dx, dy); }
  }, 16);
  seal.addEventListener('pointermove', onMove);

  const up = () => {
    if (!dr) return;
    dr = null;
    seal.classList.remove('press');
    if (!torn && R.stage === 'seal') {
      seal.style.transform = '';
      setP(0);
      $('envFloat').style.transform = '';
    }
  };
  seal.addEventListener('pointerup', up);
  seal.addEventListener('pointercancel', up);

  seal.addEventListener('click', () => { if (R.stage === 'seal' && !torn) autoPeel(); });
  seal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && R.stage === 'seal') autoPeel(); });

  function autoPeel() {
    const t0 = performance.now();
    (function f(n) {
      const k = Math.min(1, (n - t0) / 700);
      setP(k);
      seal.style.transform = `translate(-50%,-50%) translate(${k * 30}px,${k * 22}px) scale(${1 + k * .07})`;
      if (k < 1) raf(f);
      else tearSeal(30, 22);
    })(t0);
  }

  function tearSeal(dx, dy) {
    R.stage = 'flap';
    Audio.play('seal');
    navigator.vibrate?.(80);
    const L = Math.hypot(dx, dy) || 1;
    const vx = dx / L, vy = dy / L;
    seal.classList.add('gone');
    seal.animate([
      { transform: seal.style.transform, opacity: 1 },
      { transform: `translate(calc(-50% + ${vx * 60}px),calc(-50% + ${vy * 60}px)) scale(1.15)`, opacity: 1, offset: .3 },
      { transform: `translate(calc(-50% + ${vx * 150}px),calc(-50% + ${vy * 150 + 140}px)) rotate(${vx * 220}deg)`, opacity: 0 }
    ], { duration: 850, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' }).onfinish = () => { seal.style.visibility = 'hidden'; };

    glow.style.opacity = 1;
    setTimeout(() => {
      glow.style.transition = 'opacity .7s';
      glow.style.opacity = 0;
      setTimeout(() => { glow.style.transition = ''; }, 700);
    }, 140);

    const host = $('envFloat'), svg = seal.querySelector('svg');
    const rays = document.createElement('span');
    rays.className = 'seal-burst';
    host.appendChild(rays);
    setTimeout(() => rays.remove(), 850);

    const clips = [
      'polygon(0 0,55% 0,45% 30%,58% 52%,40% 56%,0 50%)',
      'polygon(55% 0,100% 0,100% 50%,62% 56%,58% 52%,45% 30%)',
      'polygon(0 50%,40% 56%,46% 78%,52% 100%,0 100%)',
      'polygon(100% 50%,62% 56%,46% 78%,52% 100%,100% 100%)'
    ];
    const dirs = [[-1,-1],[1,-1],[-1,1],[1,1]];
    clips.forEach((clip, i) => {
      const d = document.createElement('div');
      d.className = 'seal-half';
      d.style.webkitClipPath = clip;
      d.style.clipPath = clip;
      d.innerHTML = svg.outerHTML;
      host.appendChild(d);
      const [ux, uy] = dirs[i];
      d.animate([
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: `translate(${ux * 46}px,${uy * 34 - 24}px) rotate(${ux * 70}deg)`, opacity: 1, offset: .4 },
        { transform: `translate(${ux * 72}px,${uy * 30 + 130}px) rotate(${ux * 170}deg)`, opacity: 0 }
      ], { duration: 950, easing: 'cubic-bezier(.25,.6,.4,1)' });
      setTimeout(() => d.remove(), 1000);
    });

    for (let i = 0; i < 7; i++) {
      const s = document.createElement('span');
      s.className = 'shard';
      const a = Math.PI * 2 * i / 7 + Math.random() * .5;
      s.style.setProperty('--tx', Math.cos(a) * (70 + Math.random() * 60) + 'px');
      s.style.setProperty('--ty', Math.sin(a) * (70 + Math.random() * 60) + 'px');
      s.style.setProperty('--rz', (Math.random() * 260 - 130) + 'deg');
      s.style.left = '50%'; s.style.top = '52%';
      host.appendChild(s);
      setTimeout(() => s.remove(), 900);
    }
    const ring = document.createElement('span');
    ring.className = 'shock';
    host.appendChild(ring);
    setTimeout(() => ring.remove(), 800);

    host.classList.add('kaboom');
    const r = seal.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2,
      { n: 30, colors: ['#8c2537', '#a13a4a', '#e59aa6', '#f0b64b'], pow: 9, shapes: ['r','c'] });
    $('envFlap').classList.add('ready');
    setHint(HINT.flap);
  }
})();

/* ============ ЖЕСТ 2: КЛАПАН ============ */
(() => {
  const flap = $('envFlap'), env = $('env');
  let dr = null, ang = 0;

  flap.addEventListener('pointerdown', (e) => {
    if (R.stage !== 'flap') return;
    e.preventDefault();
    flap.setPointerCapture(e.pointerId);
    dr = { y: e.clientY };
    flap.style.transition = 'none';
    Audio.play('grab');
  });

  const onMove = throttle((e) => {
    if (!dr) return;
    ang = Math.max(0, Math.min(180, (dr.y - e.clientY) * (IS_TOUCH ? 1.5 : 1.15)));
    flap.style.transform = `rotateX(${ang}deg)`;
    env.classList.toggle('open', ang > 90);
  }, 16);
  flap.addEventListener('pointermove', onMove);

  const up = () => {
    if (!dr) return;
    dr = null;
    if (ang > 115) {
      flap.style.transition = 'transform .7s cubic-bezier(.3,1.4,.4,1)';
      flap.style.transform = 'rotateX(180deg)';
      env.classList.add('open');
      Audio.play('flap');
      R.stage = 'pull';
      $('envIn').classList.add('peek');
      setHint(HINT.pull);
    } else {
      flap.style.transition = 'transform .5s cubic-bezier(.3,1.4,.4,1)';
      flap.style.transform = 'rotateX(0deg)';
      env.classList.remove('open');
    }
  };
  flap.addEventListener('pointerup', up);
  flap.addEventListener('pointercancel', up);

  flap.addEventListener('click', () => {
    if (R.stage === 'flap' && ang <= 115) { ang = 179; up(); }
  });
})();

/* ============ ЖЕСТ 3: ВЫТАЩИТЬ БИЛЕТ ============ */
(() => {
  const inn = $('envIn');
  let dr = null, ty = 0;

  inn.addEventListener('pointerdown', (e) => {
    if (R.stage !== 'pull') return;
    e.preventDefault();
    inn.setPointerCapture(e.pointerId);
    dr = { y: e.clientY };
    inn.style.transition = 'none';
    Audio.play('grab');
  });

  const onMove = throttle((e) => {
    if (!dr) return;
    ty = Math.max(0, Math.min(220, dr.y - e.clientY));
    inn.style.transform = `translateY(calc(-4% - ${ty * .9}px)) rotate(${-ty * .012}deg)`;
  }, 16);
  inn.addEventListener('pointermove', onMove);

  const up = () => {
    if (!dr) return;
    dr = null;
    if (ty > 150) extract();
    else {
      inn.style.transition = 'transform .5s cubic-bezier(.3,1.4,.4,1)';
      inn.style.transform = 'translateY(-4%)';
    }
  };
  inn.addEventListener('pointerup', up);
  inn.addEventListener('pointercancel', up);

  inn.addEventListener('click', () => {
    if (R.stage === 'pull' && ty <= 150) { ty = 220; extract(); }
  });

  function extract() {
    R.stage = 'ticket';
    Audio.play('pull');
    navigator.vibrate?.(30);
    inn.animate([
      { transform: inn.style.transform, opacity: 1 },
      { transform: 'translateY(-150%) scale(1.22) rotate(-4deg)', opacity: 0 }
    ], { duration: 550, easing: 'cubic-bezier(.3,.7,.4,1)' });
    $('envFloat').animate([
      { transform: 'translateY(0)', opacity: 1 },
      { transform: 'translateY(160px) rotate(7deg)', opacity: 0 }
    ], { duration: 650, easing: 'cubic-bezier(.4,0,.8,1)', fill: 'forwards' });
    setTimeout(() => { rstage('rsMain'); buildMain(); }, 600);
  }
})();

/* ============ БИЛЕТ В РУКАХ: HOLO + DRAG ============ */
function attachHolo(ticketEl) {
  const c = document.createElement('canvas');
  c.className = 'holo';
  ticketEl.appendChild(c);
  const g = makeGL(c, HOLO_FRAG, true);
  if (!g) { c.remove(); return null; }
  ticketEl.classList.add('has-holo');
  raf(() => g.resize());
  const h = {
    g,
    st: { ry: 0, rx: 0, b: 0 },
    u: { R: g.U('uR'), T: g.U('uT'), Ry: g.U('uRy'), Rx: g.U('uRx'), P: g.U('uP'), B: g.U('uB') }
  };
  return h;
}

function attachDrag(flip, opts = {}) {
  const inn = flip.querySelector('.flip-in');
  let ry = 0, rx = 0, vy = 0;
  let down = false, moved = false;
  let lx = 0, ly = 0, pid = null, rafId = 0, animId = 0;
  const api = {};

  function apply() {
    inn.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    opts.onMove && opts.onMove(ry, rx);
  }

  const faceBack = (r) => { const m = ((r % 360) + 360) % 360; return m > 90 && m < 270; };

  function done() {
    const b = faceBack(ry);
    flip.classList.toggle('back-live', b);
    opts.onFace && opts.onFace(b);
  }

  function animateTo(target, cb, D = 620) {
    caf(animId); caf(rafId);
    const from = ry, fx = rx, t0 = performance.now();
    const step = (n) => {
      const k = Math.min(1, (n - t0) / D);
      const e = 1 - Math.pow(1 - k, 3);
      ry = from + (target - from) * e;
      rx = fx * (1 - e);
      apply();
      if (k < 1) animId = raf(step);
      else { ry = target; rx = 0; apply(); done(); cb && cb(); }
    };
    animId = raf(step);
  }

  const onDown = (e) => {
    if (confirmed) return;
    if (e.target.closest('button,input,a,textarea,.punch,.tb-stub')) return;
    down = true; moved = false; pid = e.pointerId;
    lx = e.clientX; ly = e.clientY; vy = 0;
    caf(rafId); caf(animId);
  };
  flip.addEventListener('pointerdown', onDown);

  const onMove = (e) => {
    if (!down || e.pointerId !== pid) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    if (!moved) {
      if (Math.hypot(dx, dy) < 6) return;
      moved = true;
      flip.classList.add('grab');
      try { flip.setPointerCapture(pid); } catch (err) {}
    }
    lx = e.clientX; ly = e.clientY;
    ry += dx * .55;
    rx = Math.max(-42, Math.min(42, rx - dy * .3));
    vy = vy * .65 + dx * .55 * .35;
    apply();
  };
  flip.addEventListener('pointermove', throttle(onMove, 16));

  const up = (e) => {
    if (!down || e.pointerId !== pid) return;
    down = false;
    if (!moved) return;
    flip.classList.remove('grab');
    const coast = () => {
      if (down) return;
      ry += vy * 2.4;
      vy *= .94;
      rx *= .9;
      apply();
      if (Math.abs(vy) > .3) rafId = raf(coast);
      else animateTo(Math.round(ry / 180) * 180);
    };
    coast();
  };
  flip.addEventListener('pointerup', up);
  flip.addEventListener('pointercancel', up);

  api.spinToFront = (cb) => animateTo(Math.round(ry / 360) * 360, cb, 450);
  api.destroy = () => { caf(animId); caf(rafId); };
  apply(); done();
  return api;
}

function buildMain() {
  const oc = card.oc || 'kino';
  $('rTicket').innerHTML = ticketHTML(card);

  // Удаляем старый holo
  if (holo) { try { holo.g.destroy(); } catch (e) {} holo = null; }
  holo = attachHolo($('rTicket').querySelector('.ticket'));

  $('rBack').className = 'face f-back t-' + oc;
  $('rBack').innerHTML = backHTML(card);
  bindBack();

  if (dragApi && dragApi.destroy) dragApi.destroy();
  dragApi = attachDrag($('flip'), {
    onMove: (ry, rx) => { if (holo) { holo.st.ry = ry; holo.st.rx = rx; } },
    onFace: (b) => {
      if (confirmed) return;
      const c = $('rCap'); c.classList.add('show');
      c.textContent = b
        ? 'выбери своё — и тяни корешок вниз вдоль линии ♥'
        : 'зажми билет и крутни — на обороте ответ ✨';
      $('dragHintTx').textContent = b ? 'тяни корешок вниз ↓' : 'зажми и крутни';
      $('dragHint').classList.add('show');
      $('noteFly').classList.toggle('hide', b);
    }
  });

  const nf = $('noteFly');
  nf.textContent = (card.msg || OC[oc].def) + ' — ' + (card.from || 'он');
  nf.classList.add('show');

  const w = $('rTicketWrap');
  w.className = 'r-ticket-wrap in-' + oc;
  void w.offsetWidth; // force reflow
  setTimeout(() => w.classList.add('in'), 30);
  setTimeout(() => {
    $('dragHint').classList.add('show');
    const c = $('rCap');
    c.textContent = 'зажми билет и крутни — на обороте ответ ✨';
    c.classList.add('show');
  }, 2000);

  buildDecor(oc);
}

function backHTML(c) {
  const head = `<div class="tb-head"><span class="tk-type">Билет-ответ</span><span class="tk-no">№ ${c.no || ''}</span></div>
    <button class="tb-backlink" type="button" data-unturn>← лицевая</button>`;
  const stub = `<div class="tb-stub" id="tbStub" role="button" tabindex="0" aria-label="оторвать корешок — согласие">
      <i class="nt t"></i><i class="nt b"></i>
      <span class="vs">${c.mode === 'fixed' ? 'оторви — и ты идёшь ♥' : 'оторви — и это да ♥'}</span>
      <div class="tk-bar"></div></div>
    <div class="torn-edge"></div>`;

  if (c.mode === 'fixed') {
    return `<div class="tb-pad">${head}
      <p class="tb-plan"><b>${fmtD(c.date) || 'дата уточняется'}</b> · ${esc(c.time || 'время на связи')}<br>${esc(c.place || 'место подскажет сердце')}</p>
      <p class="tb-q">${esc(c.from || 'он')} всё продумал. Согласна — оторви корешок.</p>
      <div class="tb-actions"><button class="tb-ghost" type="button" id="tbMaybe">Меня нужно уговорить</button></div></div>${stub}`;
  }

  const row = (t, k, items, fmt) => {
    const inner = items.length
      ? `<div class="punches">${items.map(v => `<button class="punch" type="button" data-pick="${k}" data-v="${esc(v)}">${fmt ? fmt(v) : esc(v)}</button>`).join('')}</div>`
      : `<input class="tb-free" data-free="${k}" ${k === 'dates' ? 'type="date"' : k === 'times' ? 'type="time"' : 'placeholder="предложи своё место" maxlength="60"'}>`;
    return `<div class="tb-row" id="row-${k}"><i>${t}</i>${inner}</div>`;
  };

  return `<div class="tb-pad">${head}
    ${row('Когда', 'dates', c.dates, fmtD)}
    ${row('Во сколько', 'times', c.times)}
    ${row('Куда', 'places', c.places)}
    <input class="tb-note" id="tbNote" maxlength="60" placeholder="пара слов от тебя…"></div>${stub}`;
}

function bindBack() {
  const back = $('rBack');
  back.querySelectorAll('.punch').forEach(p => p.addEventListener('click', (e) => {
    back.querySelectorAll(`.punch[data-pick="${p.dataset.pick}"]`).forEach(x => x.classList.remove('on'));
    p.classList.add('on');
    $('row-' + p.dataset.pick)?.classList.remove('need');
    burst(e.clientX, e.clientY, { n: 8, colors: [OC[card.oc]?.c || '#f0b64b', '#fff'], pow: 4 });
  }));

  back.querySelector('[data-unturn]')?.addEventListener('click', () => dragApi && dragApi.spinToFront());

  $('tbMaybe')?.addEventListener('click', (e) => {
    burst(e.clientX, e.clientY, { n: 8, colors: ['#ff6f61'], pow: 4, shapes: ['h'] });
    e.target.textContent = 'Ну пожааалуйста 🥺';
    e.target.style.animation = 'shake .4s';
  });

  attachTear($('tbStub'));
}

/* ============ ЖЕСТ 4: ОТРЫВ КОРЕШКА ============ */
function attachTear(stub) {
  if (!stub) return;
  const back = $('rBack');
  const edge = back.querySelector('.torn-edge');
  const gap = document.createElement('div');
  gap.className = 'tear-gap';
  back.appendChild(gap);

  const fibers = [];
  [18, 44, 70].forEach((tp, i) => {
    const el = document.createElement('span');
    el.className = 'fiber';
    el.style.top = tp + '%';
    back.appendChild(el);
    fibers.push({ el, on: 10 + i * 26, off: 22 + i * 26, sn: false });
  });

  let dr = null, dx = 0, dy = 0, f = 0, live = null, lastTick = 0, doneTear = false;

  function setProgress(m) {
    f = Math.max(0, Math.min(100, m * 100 / 90));
    const k = f / 100;
    gap.style.opacity = k > 0 ? Math.min(1, k * 1.4) : 0;
    gap.style.width = (k * 12) + 'px';
    if (edge) edge.style.setProperty('--rev', f + '%');
    fibers.forEach(fb => {
      if (f > fb.on) fb.el.classList.add('on');
      if (!fb.sn && f > fb.off) {
        fb.sn = true;
        fb.el.classList.add('snap');
        Audio.play('crack');
        const r = fb.el.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + 1, { n: 4, colors: ['#e8dcc8', '#fff'], pow: 3 });
      }
    });
    if (f - lastTick > 9) { lastTick = f; Audio.play('crack'); navigator.vibrate?.(8); }
  }

  function makeLive() {
    const r = stub.getBoundingClientRect();
    live = stub.cloneNode(true);
    live.className = 'tb-stub fly-stub';
    live.removeAttribute('id');
    live.querySelectorAll('.nt').forEach(n => n.remove());
    live.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;position:fixed;transform:none;clip-path:none`;
    document.body.appendChild(live);
    stub.style.visibility = 'hidden';
  }

  function springBack() {
    const l = live; live = null;
    if (l) {
      l.animate([
        { transform: l.style.transform || 'none' },
        { transform: 'none' }
      ], { duration: 240, easing: 'cubic-bezier(.3,1.2,.4,1)' }).onfinish = () => {
        l.remove();
        stub.style.visibility = '';
      };
    }
    const from = f, t0 = performance.now();
    (function s(n) {
      const q = Math.min(1, (n - t0) / 240);
      setProgress(from * (1 - q) * .9);
      if (q < 1) raf(s);
      else {
        gap.style.opacity = 0; gap.style.width = '0';
        fibers.forEach(fb => { fb.sn = false; fb.el.classList.remove('on', 'snap'); });
      }
    })(t0);
  }

  function detach() {
    if (doneTear) return;
    doneTear = true; confirmed = true;
    Audio.play('tear');
    navigator.vibrate?.(60);
    fibers.forEach(fb => { if (!fb.sn) { fb.sn = true; fb.el.classList.add('snap'); } });
    if (edge) edge.style.setProperty('--rev', '100%');
    const l = live; live = null;
    const cur = l.style.transform || 'none';
    const r = l.getBoundingClientRect();
    l.animate([
      { transform: cur, opacity: 1 },
      { transform: 'rotate(24deg) translate(60px,120px)', opacity: 1, offset: .4 },
      { transform: 'rotate(40deg) translate(140px,420px)', opacity: 0 }
    ], { duration: 1000, easing: 'cubic-bezier(.3,.4,.6,1)' }).onfinish = () => l.remove();
    burst(r.left + r.width / 2, r.top + r.height / 2,
      { n: 30, colors: ['#f0b64b', '#ff6f61', '#fff', '#e8dcc8'], pow: 8, shapes: ['r','c'] });
    celebrate();
  }

  stub.addEventListener('pointerdown', (e) => {
    if (confirmed) return;
    e.preventDefault(); e.stopPropagation();
    stub.setPointerCapture(e.pointerId);
    dr = { x: e.clientX, y: e.clientY };
    dx = 0; dy = 0; lastTick = 0;
    makeLive();
    Audio.play('grab');
  });

  const onMove = (e) => {
    if (!dr || !live) return;
    dx = e.clientX - dr.x;
    dy = e.clientY - dr.y;
    const m = Math.hypot(dx, dy);
    live.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.min(1, m / 90) * 10}deg)`;
    setProgress(m);
    if (f >= 100) { dr = null; detach(); }
  };
  stub.addEventListener('pointermove', throttle(onMove, 16));

  const up = () => { if (!dr) return; dr = null; if (!doneTear) springBack(); };
  stub.addEventListener('pointerup', up);
  stub.addEventListener('pointercancel', up);

  stub.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmed) {
      makeLive();
      const t0 = performance.now();
      (function g(n) {
        const k = Math.min(1, (n - t0) / 700);
        const m = k * 120;
        live.style.transform = `translate(${m * .7}px,${m * .7}px) rotate(${k * 10}deg)`;
        setProgress(m);
        if (k < 1) raf(g);
        else detach();
      })(t0);
    }
  });
}

function readSel() {
  const back = $('rBack');
  const sel = {};
  for (const k of ['dates', 'times', 'places']) {
    const on = back.querySelector(`.punch[data-pick="${k}"].on`);
    const free = back.querySelector(`[data-free="${k}"]`);
    sel[k.slice(0, -1)] = on ? on.dataset.v : (free ? free.value.trim() : '');
  }
  return sel;
}

function celebrate() {
  const sel = readSel();
  const note = $('tbNote')?.value.trim();
  const merged = { ...card, mode: 'fixed',
    date: sel.date || card.date,
    time: sel.time || card.time,
    place: sel.place || card.place
  };
  $('dragHint').classList.remove('show');
  dragApi.spinToFront(() => {
    const fr = $('rTicket');
    fr.innerHTML = ticketHTML(merged) + '<div class="stamp">ПРИНЯТО ♥</div>';

    if (holo) { try { holo.g.destroy(); } catch (e) {} }
    holo = attachHolo(fr.querySelector('.ticket'));
    if (holo) holo.st.b = 1;

    raf(() => fr.querySelector('.ticket').classList.add('stamped'));
    Audio.play('stamp');
    setTimeout(() => Audio.play('yay'), 250);

    const r = fr.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2,
      { n: 80, colors: ['#ff6f61', '#f0b64b', '#ff9db0', '#fff'], pow: 10, shapes: ['h','h','c','r'] });
    $('yay').classList.add('show');
    setTimeout(() => $('yay').classList.remove('show'), 1700);

    const cap = $('rCap'); cap.classList.add('show');
    const code = enc({ c: merged, s: sel, n: note || '', t: Date.now() });
    const replyUrl = baseHref() + '#/a/' + code;
    cap.innerHTML = `она сказала «да» ✈ отправь ему ответный билет<br>
      <span class="hand">${fmtD(merged.date) || 'дата — сюрприз'} · ${merged.time || '—'} · ${esc(merged.place || '—')}</span>
      <div class="link-row" style="justify-content:center;margin-top:18px">
        <input class="inp" id="replyOut" readonly value="${replyUrl}" aria-label="Ссылка ответа">
        <button class="btn" type="button" id="replyCopy">Копировать</button>
      </div>
      ${navigator.share && /^https?:$/.test(location.protocol) ? '<div style="margin-top:12px"><button class="btn btn-ghost" type="button" id="sendHim">Поделиться ♥</button></div>' : ''}`;

    $('replyCopy').addEventListener('click', async (e) => {
      const ok = await copyText(replyUrl);
      e.target.textContent = ok ? 'Скопировано ✓' : 'выдели ссылку и скопируй';
      burst(e.clientX, e.clientY, { n: 18, colors: ['#7ad0b2', '#f0b64b'], pow: 6 });
    });
    $('sendHim')?.addEventListener('click', async (e) => {
      try {
        await navigator.share({ title: 'Билетик ♥', text: 'Я иду! Ответ — в ссылке ♥', url: replyUrl });
        e.target.textContent = 'Отправлено ✓';
      } catch (err) {}
    });
  });
}

function buildDecor(oc) {
  const st = $('revealStage');
  st.className = 'reveal-stage rv-' + oc;
  let h = '';
  if (oc === 'teatr') h = '<div class="curt curt-l"></div><div class="curt curt-r"></div>';
  if (oc === 'kino') h = '<div class="spot sp-a"></div><div class="spot sp-b"></div><div class="film-run"></div>';
  if (oc === 'park') {
    h = '<svg class="wheel" viewBox="0 0 100 100" fill="none" stroke="#5fc98a" stroke-width="2"><circle cx="50" cy="45" r="34"/><path d="M50 11v68M16 45h68M26 21l48 48M74 21 26 69"/><path d="M38 96l12-18 12 18"/></svg>';
    for (let i = 0; i < 12; i++) {
      h += `<span class="leaf" style="left:${Math.random() * 100}%;--d:${3 + Math.random() * 3}s;--dl:${Math.random() * 2.5}s;--sx:${Math.random() * 120 - 60}px;--l1:${['#8ccb7a','#c9d97a','#e2b25a'][i % 3]};--l2:#3f9d63"></span>`;
    }
  }
    if (oc === 'kafe') {
    let bokeh = '', beans = '';
    for (let i = 0; i < 7; i++) bokeh += `<i style="left:${8 + Math.random() * 84}%;top:${10 + Math.random() * 40}%;width:${18 + Math.random() * 26}px;height:${18 + Math.random() * 26}px;animation-delay:${(Math.random() * 4).toFixed(2)}s"></i>`;
    for (let i = 0; i < 10; i++) beans += `<span class="cf-bean" style="left:${Math.random() * 100}%;--d:${(3 + Math.random() * 3).toFixed(2)}s;--dl:${(0.8 + Math.random() * 3).toFixed(2)}s;--sx:${(Math.random() * 120 - 60).toFixed(0)}px"></span>`;
    h = `<div class="cf-scene">
      <span class="cf-bokeh">${bokeh}</span>
      <span class="cf-lamp"><span class="cf-cone"></span></span>
      <span class="cf-table"></span>
      <span class="cf-cup cf-l"><span class="cf-steam"><i></i><i></i><i></i></span><span class="cf-body"></span><span class="cf-handle"></span><span class="cf-saucer"></span></span>
      <span class="cf-cup cf-r"><span class="cf-steam"><i></i><i></i><i></i></span><span class="cf-body"></span><span class="cf-handle"></span><span class="cf-saucer"></span></span>
      <svg class="cf-heart" viewBox="0 0 100 90" aria-hidden="true"><path pathLength="1" d="M50 78C28 60 12 46 12 30 12 18 21 10 32 10 39 10 46 14 50 21 54 14 61 10 68 10 79 10 88 18 88 30 88 46 72 60 50 78Z"/></svg>
      ${beans}
    </div>`;
    setTimeout(() => {
      const r = st.getBoundingClientRect();
      burst(r.left + r.width * .26, r.top + r.height * .78, { n: 10, colors: ['#ffd9a0', '#e2965a', '#fff'], pow: 4 });
      burst(r.left + r.width * .74, r.top + r.height * .78, { n: 10, colors: ['#ffd9a0', '#e2965a', '#fff'], pow: 4 });
    }, 1300);
  }
  if (oc === 'koncert') h = `<div class="eq">${Array.from({ length: 20 }, (_, i) => `<i style="--d:${i * 0.06}s;--h:${30 + Math.random() * 70}%"></i>`).join('')}</div>`;
    if (oc === 'syurpriz') {
    let stars = '';
    for (let i = 0; i < 26; i++) stars += `<i style="left:${Math.random() * 100}%;top:${Math.random() * 70}%;--d:${(1.5 + Math.random() * 2).toFixed(2)}s;--dl:${(Math.random() * 3).toFixed(2)}s"></i>`;
    h = `<div class="sy-scene">
      <span class="sy-stars">${stars}</span>
      <span class="sy-shoot sy-a"></span><span class="sy-shoot sy-b"></span>
      <span class="sy-glow"></span>
      <span class="sy-ring sy-r1"></span><span class="sy-ring sy-r2"></span>
      <div class="qm" id="qm">?</div>
      <div class="sy-heart" id="syHeart">♥</div>
    </div>`;
    setTimeout(() => {
      const q = $('qm'); if (!q) return;
      q.classList.add('gone');
      $('syHeart')?.classList.add('show');
      for (let i = 0; i < 14; i++) {
        const s = document.createElement('span');
        s.className = 'spark';
        const a = Math.PI * 2 * i / 14;
        s.style.setProperty('--tx', Math.cos(a) * (90 + Math.random() * 70) + 'px');
        s.style.setProperty('--ty', Math.sin(a) * (90 + Math.random() * 70) + 'px');
        st.appendChild(s);
      }
      const r = st.getBoundingClientRect();
      [[.24, .26, 0], [.76, .22, 380], [.5, .12, 760]].forEach(([px, py, dl]) =>
        setTimeout(() => burst(r.left + r.width * px, r.top + r.height * py,
          { n: 26, colors: ['#f2c94c', '#8fb2ff', '#ff6f61', '#fff'], pow: 8, shapes: ['c', 'r'] }), dl));
    }, 1100);
  }
  st.innerHTML = h;
}

/* ============ ОТВЕТНЫЙ БИЛЕТ ============ */
function openReply(d) {
  Object.assign(card, freshCard(), d.c || {});
  const s = d.s || {};
  const merged = { ...card, mode: 'fixed',
    date: s.date || card.date,
    time: s.time || card.time,
    place: s.place || card.place
  };
  previewMode = false;
  $$('.view').forEach(v => v.classList.remove('active'));
  $('v-reply').classList.add('active');
  curView = 'v-reply';
  setZen(true);
  document.body.classList.remove('preview');

  $('repKicker').innerHTML = `Она сказала «ДА»! ♥<small>ответный билет от ${esc(card.to || 'неё')}</small>`;
  const slot = $('repTicket');
  slot.innerHTML = ticketHTML(merged) + '<div class="stamp">ПРИНЯТО ♥</div>';
  if (holo) { try { holo.g.destroy(); } catch (e) {} }
  holo = attachHolo(slot.querySelector('.ticket'));
  setTimeout(() => slot.querySelector('.ticket').classList.add('stamped'), 900);

  $('repSum').innerHTML =
    `<span>📅 ${fmtD(merged.date) || 'дата — сюрприз'}</span><span>🕒 ${merged.time || 'время на связи'}</span><span>📍 ${esc(merged.place || 'место в сердце')}</span>`;
  $('repNote').textContent = d.n ? `«${d.n}»` : '';
  $('repMeta').textContent = 'свидание подтверждено · билет № ' + (merged.no || '');

  setTimeout(() => {
    $('yay').classList.add('show');
    setTimeout(() => $('yay').classList.remove('show'), 1700);
    burst(innerWidth / 2, innerHeight * .35,
      { n: 90, colors: ['#ff6f61', '#f0b64b', '#ff9db0', '#fff'], pow: 10, shapes: ['h','h','c','r'] });
  }, 800);
}

/* ============ РОУТИНГ ============ */
function parseHash() {
  let m = location.hash.match(/^#\/k\/(.+)$/);
  if (m) {
    try {
      const c = dec(m[1]);
      Object.assign(card, freshCard(), c);
      previewMode = false;
      $$('.view').forEach(v => v.classList.remove('active'));
      $('v-card').classList.add('active');
      curView = 'v-card';
      setZen(true);
      document.body.classList.remove('preview');
      startRecipient();
      return true;
    } catch (e) { return false; }
  }
  m = location.hash.match(/^#\/a\/(.+)$/);
  if (m) {
    try { openReply(dec(m[1])); return true; }
    catch (e) { return false; }
  }
  return false;
}
window.addEventListener('hashchange', () => {
  if (parseHash()) window.scrollTo({ top: 0 });
});

/* ============ КОНФЕТТИ С ЛИМИТОМ ============ */
const fxC = $('fx'), fctx = fxC.getContext('2d');
let P = [], fxOn = false;
const MAX_PARTICLES = 400;

function sizeFx() {
  const d = devicePixelRatio || 1;
  fxC.width = innerWidth * d;
  fxC.height = innerHeight * d;
  fctx.setTransform(d, 0, 0, d, 0, 0);
}
sizeFx();

function heart(x, s) {
  fctx.beginPath();
  fctx.moveTo(0, s * .3);
  fctx.bezierCurveTo(-s * .55, -s * .25, -s * .2, -s * .62, 0, -s * .25);
  fctx.bezierCurveTo(s * .2, -s * .62, s * .55, -s * .25, 0, s * .3);
  fctx.fill();
}

function burst(x, y, { n = 24, colors = ['#f0b64b', '#ff6f61', '#7ad0b2', '#fff'], pow = 7, shapes = ['r', 'c'] } = {}) {
  if (REDUCED_MOTION) return;
  const actual = Math.min(n, MAX_PARTICLES - P.length);
  for (let i = 0; i < actual; i++) {
    const a = -Math.PI / 2 + (Math.random() - .5) * 1.9;
    const v = pow * (.35 + Math.random() * .85);
    P.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      s: 3 + Math.random() * 5,
      r: Math.random() * 6.3,
      vr: (Math.random() - .5) * .35,
      c: colors[i % colors.length],
      life: 55 + Math.random() * 45,
      sh: shapes[i % shapes.length]
    });
  }
  if (!fxOn) { fxOn = true; raf(tickFx); }
}

function tickFx() {
  fctx.clearRect(0, 0, innerWidth, innerHeight);
  P = P.filter(p => p.life > 0 && p.y < innerHeight + 40);
  for (const p of P) {
    p.life--;
    p.vy += .13;
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= .985;
    p.r += p.vr;
    fctx.save();
    fctx.translate(p.x, p.y);
    fctx.rotate(p.r);
    fctx.globalAlpha = Math.min(1, p.life / 26);
    fctx.fillStyle = p.c;
    if (p.sh === 'r') fctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .62);
    else if (p.sh === 'h') heart(0, p.s * 1.2);
    else { fctx.beginPath(); fctx.arc(0, 0, p.s / 2, 0, 6.3); fctx.fill(); }
    fctx.restore();
  }
  if (P.length) raf(tickFx);
  else { fxOn = false; fctx.clearRect(0, 0, innerWidth, innerHeight); }
}

/* ============ ГЛАВНЫЙ ЦИКЛ АНИМАЦИЙ ============ */
function masterLoop(t) {
  if (!masterLoopRunning) return;
  const time = t / 1000;
  mouse.sx += (mouse.x - mouse.sx) * .05;
  mouse.sy += (mouse.y - mouse.sy) * .05;
  const dimT = document.body.classList.contains('zen') ? 1 : 0;
  dim += (dimT - dim) * .05;

  if (bgGL && bgU && !bgGL.lost) {
    try {
      const g = bgGL.gl;
      const pr = bgGL.pr();
      if (pr) {
        g.useProgram(pr);
        g.uniform2f(bgU.R, g.drawingBufferWidth, g.drawingBufferHeight);
        g.uniform1f(bgU.T, time);
        g.uniform2f(bgU.P, mouse.sx, mouse.sy);
        g.uniform1f(bgU.D, dim);
        g.drawArrays(g.TRIANGLES, 0, 3);
      }
    } catch (e) {}
  }

  if (holo && holo.g && !holo.g.lost) {
    try {
      const c = holo.g;
      const g = c.gl;
      holo.st.b *= .94;
      if (c.canvas.clientWidth) {
        const pr = c.pr();
        if (pr) {
          g.useProgram(pr);
          g.uniform2f(holo.u.R, c.canvas.width, c.canvas.height);
          g.uniform1f(holo.u.T, time);
          g.uniform1f(holo.u.Ry, holo.st.ry);
          g.uniform1f(holo.u.Rx, holo.st.rx);
          g.uniform2f(holo.u.P, mouse.sx, mouse.sy);
          g.uniform1f(holo.u.B, holo.st.b);
          g.clearColor(0, 0, 0, 0);
          g.clear(g.COLOR_BUFFER_BIT);
          g.drawArrays(g.TRIANGLES, 0, 3);
        }
      }
    } catch (e) {}
  }

  mainRAF = raf(masterLoop);
}

/* ============ УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ ============ */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    masterLoopRunning = false;
    if (mainRAF) { caf(mainRAF); mainRAF = null; }
  } else {
    masterLoopRunning = true;
    if (!mainRAF) mainRAF = raf(masterLoop);
    // Синхронизация resize после возвращения
    debouncedResize();
  }
});

const debouncedResize = debounce(() => {
  sizeFx();
  if (bgGL) bgGL.resize();
  if (holo && holo.g) holo.g.resize();
}, 200);
window.addEventListener('resize', debouncedResize);

/* ============ ЗВУК КНОПКА ============ */
$('sndBtn').addEventListener('click', () => {
  const muted = Audio.toggle();
  $('sndBtn').textContent = muted ? '🔇' : '🔊';
  $('sndBtn').setAttribute('aria-label', muted ? 'включить звук' : 'выключить звук');
});

/* ============ ЗАПУСК ============ */
if (!parseHash()) setAccent();
mainRAF = raf(masterLoop);

// Cleanup перед выгрузкой
window.addEventListener('beforeunload', () => {
  masterLoopRunning = false;
  if (mainRAF) caf(mainRAF);
  if (bgGL) bgGL.destroy();
  if (holo && holo.g) holo.g.destroy();
  if (revealObserver) revealObserver.disconnect();
});

/* ============ TOUCH GUARD: скролл, выделение, контекстное меню ============ */
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.env, #flip, .tb-stub')) e.preventDefault();
});
const LOCK_SEL = '.seal, .env-flap, .env-in, #flip, .tb-stub';
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest(LOCK_SEL)) document.documentElement.classList.add('no-scroll');
}, { passive: true });
['pointerup', 'pointercancel'].forEach(t =>
  document.addEventListener(t, () => document.documentElement.classList.remove('no-scroll')));