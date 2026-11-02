(() => {
  // ---------- Setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const STEP = 1 / 120;        // physics runs at a fixed rate so bounces don't depend on frame rate
  const RADIUS = 18;
  const GRAVITY = 1500;        // pixels per second squared
  const DROP_GRAVITY = 1.7;    // gravity multiplier while Down is held
  const BOUNCE_SPEED = 640;    // the ball never leaves flat ground slower than this, so it keeps bouncing
  const HIGH_BOUNCE = 800;     // same, while Up is held
  const LOW_BOUNCE = 380;      // same, while Down is held
  const MAX_BOUNCE = 900;
  const RESTITUTION = 0.88;    // share of impact speed returned, which only matters after a long fall
  const SOFT_RESTITUTION = 0.45; // same, while Down is held
  const GRIP = 0.97;           // share of sideways speed kept through a bounce
  const AIR_ACCEL = 900;       // steering, in pixels per second squared
  const MAX_SPEED = 320;       // steering stops adding speed past this
  const DRAG = 0.5;            // sideways slowdown per second with no key held
  const WIN_DRAG = 2.5;        // same, after crossing the finish
  const FALL_LINE = H + 80;    // the run is lost once the ball's center drops below this

  // ---------- Course ----------
  // The surface is one line from left to right. Heights are in canvas pixels, so smaller is higher.
  const PIT_FLOOR = H + 400;   // pit walls run down to here, out of reach of the ball
  const surface = [];          // {x, y}
  const pits = [];             // {left, right, top}
  let cx = 0;
  let cy = 410;

  function point() { surface.push({ x: cx, y: cy }); }
  function flat(len) { cx += len; point(); }
  function ledge(rise) { cy -= rise; point(); }
  function curve(len, shape) {
    const startX = cx;
    const startY = cy;
    const pieces = Math.max(8, Math.round(len / 24));
    for (let i = 1; i <= pieces; i++) {
      const t = i / pieces;
      cx = startX + len * t;
      cy = startY - shape(t);
      point();
    }
  }
  function slope(len, rise) { curve(len, t => rise * (1 - Math.cos(Math.PI * t)) / 2); }
  function hill(len, height) { curve(len, t => height * Math.sin(Math.PI * t) ** 2); }
  function pit(width, rise = 0) {
    const left = cx;
    const leftY = cy;
    cy = PIT_FLOOR; point();
    cx += width; point();
    cy = leftY - rise; point();
    pits.push({ left, right: cx, top: Math.max(leftY, cy) });
  }

  cy = -600; point();          // wall behind the start
  cy = 410; point();

  // Warm up
  flat(760);
  hill(420, 30);
  flat(220);
  pit(90);
  flat(460);

  // Rolling ground
  hill(380, 45);
  flat(120);
  pit(105);
  flat(320);
  slope(420, 70);
  flat(200);
  pit(115, -40);
  flat(300);

  // Hills right up against the edges
  hill(300, 40);
  hill(320, 55);
  pit(120);
  hill(360, 40);
  flat(220);
  ledge(45);
  flat(260);
  ledge(45);
  flat(320);
  pit(130, -30);
  flat(240);

  // Narrow ground between pits
  slope(360, -60);
  flat(100);
  pit(130);
  flat(320);
  pit(135);
  flat(240);
  pit(125, 40);
  flat(260);

  // Downhill run into the widest gaps
  slope(420, -50);
  hill(260, 35);
  flat(160);
  pit(135, 20);
  flat(240);
  hill(280, 50);
  flat(260);
  pit(145);
  flat(300);
  slope(340, 50);
  flat(200);
  pit(155, -40);

  // Home stretch
  flat(480);
  const FINISH = cx;
  flat(W);
  const WORLD_END = cx;
  cy = -600; point();          // wall past the finish

  // Line segments for collision. Walls are the vertical ones.
  const segments = surface.slice(1).map((b, i) => {
    const a = surface[i];
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, wall: a.x === b.x };
  });

  // ---------- Input ----------
  const KEY_NAMES = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const keys = { left: false, right: false, up: false, down: false };

  window.addEventListener('keydown', e => {
    if (KEY_NAMES[e.key]) keys[KEY_NAMES[e.key]] = true;
    if (KEY_NAMES[e.key] || e.key === ' ') e.preventDefault();
    if (e.repeat) return;
    if ((e.key === ' ' || e.key === 'Enter') && mode !== 'playing') startRun();
    if (e.key === 'r' || e.key === 'R') startRun();
    if (e.key === 'm' || e.key === 'M') muted = !muted;
  });
  window.addEventListener('keyup', e => {
    if (KEY_NAMES[e.key]) keys[KEY_NAMES[e.key]] = false;
  });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // Keys only steer during a run; the rest of the time the ball just bounces.
  function held(name) { return mode === 'playing' && keys[name]; }

  // ---------- Panels ----------
  const overlay = document.getElementById('overlay');
  const panelTitle = document.getElementById('panel-title');
  const panelText = document.getElementById('panel-text');
  const panelHelp = document.getElementById('panel-help');
  const panelButton = document.getElementById('panel-button');

  function showPanel(title, text, button) {
    panelTitle.textContent = title;
    panelText.textContent = text;
    panelButton.textContent = button;
    panelHelp.hidden = true;
    overlay.hidden = false;
  }

  panelButton.addEventListener('click', startRun);

  // ---------- Game state ----------
  let mode = 'title';          // 'title', 'playing', 'lost' or 'won'
  let clock = 0;               // seconds in this run
  let cameraX = 0;
  const ball = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0, squash: 0, normalX: 0, normalY: -1 };
  const bits = [];             // dust and confetti: {x, y, vx, vy, life, age, size, color, gravity}

  function placeBall() {
    Object.assign(ball, { x: 140, y: 300, vx: 0, vy: 0, angle: 0, spin: 0, squash: 0 });
    cameraX = 0;
    bits.length = 0;
  }

  function startRun() {
    startAudio();
    placeBall();
    clock = 0;
    mode = 'playing';
    overlay.hidden = true;
    canvas.focus();
  }

  function progress() {
    return Math.max(0, Math.min(1, ball.x / FINISH));
  }

  function loseRun() {
    mode = 'lost';
    tone(420, 70, 0.6, 0.12, 'triangle');
    showPanel('Down the pit!', `You got ${Math.round(progress() * 100)}% of the way.`, 'Try Again');
  }

  function winRun() {
    mode = 'won';
    [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.18, 0.1, 'triangle', i * 0.11));
    addConfetti();
    showPanel('You made it!', `Finished in ${clock.toFixed(1)} seconds.`, 'Play Again');
  }

  // ---------- Physics ----------
  function stepBall() {
    const dir = held('right') - held('left');
    if (dir && dir * ball.vx < MAX_SPEED) ball.vx += dir * AIR_ACCEL * STEP;
    if (!dir) ball.vx *= 1 - (mode === 'won' ? WIN_DRAG : DRAG) * STEP;
    ball.vy += GRAVITY * (held('down') ? DROP_GRAVITY : 1) * STEP;
    ball.x += ball.vx * STEP;
    ball.y += ball.vy * STEP;
    ball.angle += ball.spin * STEP;
    for (const seg of segments) collide(seg);
    if (mode === 'playing') {
      clock += STEP;
      if (ball.y > FALL_LINE) loseRun();
      else if (ball.x >= FINISH) winRun();
    }
  }

  function collide(seg) {
    if (seg.x2 < ball.x - RADIUS || seg.x1 > ball.x + RADIUS) return;
    // Closest point on the segment to the ball's center
    const sx = seg.x2 - seg.x1;
    const sy = seg.y2 - seg.y1;
    const t = Math.max(0, Math.min(1, ((ball.x - seg.x1) * sx + (ball.y - seg.y1) * sy) / (sx * sx + sy * sy)));
    const dx = ball.x - (seg.x1 + sx * t);
    const dy = ball.y - (seg.y1 + sy * t);
    const dist = Math.hypot(dx, dy);
    if (dist >= RADIUS || dist === 0) return;
    const nx = dx / dist;
    const ny = dy / dist;
    ball.x += nx * (RADIUS - dist);
    ball.y += ny * (RADIUS - dist);
    bounce(nx, ny);
  }

  // Swaps the ball's speed into the surface for speed away from it. The minimum bounce
  // scales with how much the surface faces up, so walls just knock the ball back.
  function bounce(nx, ny) {
    const into = -(ball.vx * nx + ball.vy * ny);
    if (into <= 0) return;
    const along = (ball.vx * -ny + ball.vy * nx) * GRIP;
    const facing = Math.max(0, -ny);
    const wanted = held('up') ? HIGH_BOUNCE : held('down') ? LOW_BOUNCE : BOUNCE_SPEED;
    const kept = into * (held('down') ? SOFT_RESTITUTION : RESTITUTION);
    const out = Math.min(MAX_BOUNCE, Math.max(kept, wanted * facing));
    ball.vx = -ny * along + nx * out;
    ball.vy = nx * along + ny * out;
    ball.spin = along / RADIUS;
    ball.squash = Math.min(1, into / 800);
    ball.normalX = nx;
    ball.normalY = ny;
    addDust(into);
    tone(150 + out * 0.3, 90 + out * 0.15, 0.14, 0.05 * Math.min(1, into / 700));
  }

  function updateCamera(dt) {
    const target = Math.max(0, Math.min(WORLD_END - W, ball.x - W * 0.36 + ball.vx * 0.25));
    cameraX += (target - cameraX) * Math.min(1, 6 * dt);
  }

  // ---------- Effects ----------
  function addBit(bit) {
    bits.push({ age: 0, gravity: 500, ...bit });
  }

  function addDust(impact) {
    if (impact < 500) return;
    for (let i = 0; i < 5; i++) {
      addBit({
        x: ball.x - ball.normalX * RADIUS,
        y: ball.y - ball.normalY * RADIUS,
        vx: (Math.random() - 0.5) * 180,
        vy: -Math.random() * 90,
        life: 0.35,
        size: 3,
        color: '#c9b48a'
      });
    }
  }

  function addConfetti() {
    const colors = ['#ff7a66', '#ffd966', '#7fc0ff', '#8dffb0', '#dba6ff'];
    for (let i = 0; i < 120; i++) {
      addBit({
        x: ball.x + (Math.random() - 0.5) * 60,
        y: ball.y - 40,
        vx: (Math.random() - 0.5) * 520,
        vy: -200 - Math.random() * 420,
        life: 1.6 + Math.random(),
        size: 5,
        color: colors[i % colors.length]
      });
    }
  }

  function updateBits(dt) {
    for (const bit of bits) {
      bit.age += dt;
      bit.vy += bit.gravity * dt;
      bit.x += bit.vx * dt;
      bit.y += bit.vy * dt;
    }
    for (let i = bits.length - 1; i >= 0; i--)
      if (bits[i].age >= bits[i].life) bits.splice(i, 1);
  }

  // ---------- Sound ----------
  let audio = null;
  let muted = false;

  function startAudio() {
    if (audio) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) audio = new AudioCtx();
  }

  function tone(from, to, length, volume, type = 'sine', delay = 0) {
    if (!audio || muted) return;
    const start = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + length);
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + length);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + length);
  }

  // ---------- Drawing ----------
  const groundPath = new Path2D();
  const grassPath = new Path2D();
  surface.forEach((p, i) => {
    if (i === 0) groundPath.moveTo(p.x, p.y);
    else groundPath.lineTo(p.x, p.y);
  });
  groundPath.lineTo(WORLD_END, H + 500);
  groundPath.lineTo(0, H + 500);
  groundPath.closePath();
  segments.forEach(seg => {
    if (seg.wall) return;
    grassPath.moveTo(seg.x1, seg.y1);
    grassPath.lineTo(seg.x2, seg.y2);
  });

  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#6fc3ee');
    sky.addColorStop(1, '#d9f2f4');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff2b3';
    ctx.beginPath();
    ctx.arc(W - 130, 90, 40, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCloud(x, y, size) {
    ctx.fillStyle = 'rgba(255, 255, 255, .85)';
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.arc(x + size, y + size * 0.2, size * 0.75, 0, Math.PI * 2);
    ctx.arc(x - size, y + size * 0.25, size * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawClouds() {
    const spacing = 340;
    const scroll = cameraX * 0.15;
    const first = Math.floor(scroll / spacing) - 1;
    for (let i = first; i < first + 5; i++) {
      const wobble = Math.sin(i * 12.9) * 0.5 + 0.5;
      drawCloud(i * spacing - scroll, 60 + wobble * 90, 18 + wobble * 14);
    }
  }

  function drawHills(parallax, base, height, color) {
    const scroll = cameraX * parallax;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W + 12; x += 12) {
      const wx = x + scroll;
      ctx.lineTo(x, base - height * (Math.sin(wx * 0.006) + 0.5 * Math.sin(wx * 0.0147 + 1)));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  function drawPit(pit) {
    if (pit.right < cameraX || pit.left > cameraX + W) return;
    const dark = ctx.createLinearGradient(0, pit.top, 0, H);
    dark.addColorStop(0, 'rgba(24, 16, 32, 0)');
    dark.addColorStop(0.4, 'rgba(24, 16, 32, .92)');
    dark.addColorStop(1, '#0c0812');
    ctx.fillStyle = dark;
    ctx.fillRect(pit.left, pit.top, pit.right - pit.left, H - pit.top);
  }

  function drawGround() {
    const dirt = ctx.createLinearGradient(0, 300, 0, H);
    dirt.addColorStop(0, '#8a5f3c');
    dirt.addColorStop(1, '#4e3423');
    ctx.fillStyle = dirt;
    ctx.fill(groundPath);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.save();
    ctx.translate(0, 7);
    ctx.strokeStyle = '#3f8a3f';
    ctx.lineWidth = 12;
    ctx.stroke(grassPath);
    ctx.restore();
    ctx.strokeStyle = '#6cc44f';
    ctx.lineWidth = 8;
    ctx.stroke(grassPath);
  }

  function drawFlag(time) {
    const x = FINISH;
    const top = surface.find(p => p.x >= x).y - 130;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(x - 3, top, 6, 130);
    ctx.fillStyle = '#ffd966';
    ctx.beginPath();
    ctx.arc(x, top, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8503a';
    ctx.beginPath();
    ctx.moveTo(x + 3, top + 6);
    for (let i = 0; i <= 8; i++)
      ctx.lineTo(x + 3 + i * 8, top + 6 + Math.sin(time * 5 + i * 0.8) * 3);
    for (let i = 8; i >= 0; i--)
      ctx.lineTo(x + 3 + i * 8, top + 44 + Math.sin(time * 5 + i * 0.8) * 3);
    ctx.closePath();
    ctx.fill();
  }

  function drawBall() {
    // Flatten against the last surface touched, and stretch a little along the way it's moving.
    const speed = Math.hypot(ball.vx, ball.vy);
    const stretch = Math.min(0.14, speed / 6000);
    const flatten = ball.squash * 0.38;
    ctx.save();
    ctx.translate(ball.x, ball.y);
    if (flatten > stretch) {
      ctx.translate(-ball.normalX * RADIUS * flatten, -ball.normalY * RADIUS * flatten);
      ctx.rotate(Math.atan2(ball.normalY, ball.normalX));
      ctx.scale(1 - flatten, 1 + flatten * 0.7);
    } else if (speed > 0) {
      ctx.rotate(Math.atan2(ball.vy, ball.vx));
      ctx.scale(1 + stretch, 1 - stretch * 0.7);
      ctx.rotate(-Math.atan2(ball.vy, ball.vx));
    }

    // Rubber
    const rubber = ctx.createRadialGradient(-6, -7, 2, 0, 0, RADIUS);
    rubber.addColorStop(0, '#ff8f7a');
    rubber.addColorStop(0.6, '#e8503a');
    rubber.addColorStop(1, '#a42a22');
    ctx.fillStyle = rubber;
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // A band around the middle shows the spin
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(ball.angle);
    ctx.fillStyle = '#ffd966';
    ctx.fillRect(-RADIUS, -4, RADIUS * 2, 8);
    ctx.restore();

    // Shine
    ctx.fillStyle = 'rgba(255, 255, 255, .55)';
    ctx.beginPath();
    ctx.ellipse(-6, -8, 5, 3, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBits() {
    for (const bit of bits) {
      ctx.globalAlpha = 1 - bit.age / bit.life;
      ctx.fillStyle = bit.color;
      ctx.fillRect(bit.x - bit.size / 2, bit.y - bit.size / 2, bit.size, bit.size);
    }
    ctx.globalAlpha = 1;
  }

  // Progress bar across the top, with a notch for each pit
  function drawHud() {
    const left = 40;
    const width = W - 80;
    const y = 20;
    ctx.fillStyle = 'rgba(20, 22, 28, .55)';
    ctx.fillRect(left, y, width, 8);
    ctx.fillStyle = '#ffd966';
    ctx.fillRect(left, y, width * progress(), 8);
    ctx.fillStyle = '#14161c';
    for (const pit of pits)
      ctx.fillRect(left + width * pit.left / FINISH, y, Math.max(3, width * (pit.right - pit.left) / FINISH), 8);
    ctx.fillStyle = '#e8503a';
    ctx.beginPath();
    ctx.arc(left + width * progress(), y + 4, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(time) {
    drawSky();
    drawClouds();
    drawHills(0.25, 330, 32, '#a9dcc4');
    drawHills(0.45, 390, 26, '#86c9a0');
    ctx.save();
    ctx.translate(-Math.round(cameraX), 0);
    pits.forEach(drawPit);
    drawGround();
    drawFlag(time);
    drawBall();
    drawBits();
    ctx.restore();
    drawHud();
  }

  // ---------- Loop ----------
  let lastTime = 0;
  let spare = 0;

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    spare += dt;
    while (spare >= STEP) {
      if (mode !== 'lost') stepBall();
      spare -= STEP;
    }
    ball.squash = Math.max(0, ball.squash - dt * 7);
    updateCamera(dt);
    updateBits(dt);
    draw(now / 1000);
    requestAnimationFrame(frame);
  }

  placeBall();
  requestAnimationFrame(t => {
    lastTime = t;
    frame(t);
  });
})();
