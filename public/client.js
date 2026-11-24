const socket = io();

const menuScreen = document.getElementById('menu-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const codeInput = document.getElementById('code-input');
const errorText = document.getElementById('error-text');
const roomDisplay = document.getElementById('room-display');
const statusDisplay = document.getElementById('status-display');
const lobbyOverlay = document.getElementById('lobby-overlay');
const playerListDiv = document.getElementById('player-list');
const startBtn = document.getElementById('start-btn');
const waitMsg = document.getElementById('wait-msg');
const dashBtn = document.getElementById('dash-btn');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

let myId = null;
let latestState = null;

// Resize canvas cleanly for phone screens
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Menu Button Actions
document.getElementById('create-btn').onclick = () => {
  socket.emit('createRoom', nameInput.value);
};

document.getElementById('join-btn').onclick = () => {
  socket.emit('joinRoom', { code: codeInput.value, playerName: nameInput.value });
};

startBtn.onclick = () => {
  socket.emit('startGame');
};

socket.on('errorMsg', (msg) => {
  errorText.textContent = msg;
});

socket.on('joined', ({ code, playerId }) => {
  myId = playerId;
  menuScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  roomDisplay.textContent = `Room: ${code}`;
});

// Virtual Touch Joystick Logic
const joyZone = document.getElementById('joystick-zone');
const joyKnob = document.getElementById('joystick-knob');
let joyActive = false;
let currentAngle = 0;

function handleJoyMove(clientX, clientY) {
  const rect = joyZone.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = clientX - centerX;
  const dy = clientY - centerY;
  const maxDist = 40;
  const dist = Math.min(Math.hypot(dx, dy), maxDist);
  currentAngle = Math.atan2(dy, dx);

  joyKnob.style.transform = `translate(${Math.cos(currentAngle) * dist}px, ${Math.sin(currentAngle) * dist}px)`;
  socket.emit('input', { angle: currentAngle, active: dist > 8 });
}

joyZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  joyActive = true;
  handleJoyMove(e.touches[0].clientX, e.touches[0].clientY);
});

joyZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (joyActive) handleJoyMove(e.touches[0].clientX, e.touches[0].clientY);
});

joyZone.addEventListener('touchend', () => {
  joyActive = false;
  joyKnob.style.transform = 'translate(0px, 0px)';
  socket.emit('input', { angle: currentAngle, active: false });
});

// Desktop Keyboard fallback (for testing on laptop)
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.code === 'Space') socket.emit('dash');
  updateKeyboardInput();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  updateKeyboardInput();
});

function updateKeyboardInput() {
  let dx = 0, dy = 0;
  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  if (dx !== 0 || dy !== 0) {
    currentAngle = Math.atan2(dy, dx);
    socket.emit('input', { angle: currentAngle, active: true });
  } else {
    socket.emit('input', { angle: currentAngle, active: false });
  }
}

// Dash Button
dashBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  socket.emit('dash');
});
dashBtn.onclick = () => socket.emit('dash');

// Receive Server Updates & Draw Frame
socket.on('state', (state) => {
  latestState = state;

  // Toggle lobby overlay
  if (state.status === 'lobby') {
    lobbyOverlay.classList.remove('hidden');
    playerListDiv.innerHTML = state.players
      .map((p) => `<div style="color:${p.color}">#${p.num} ${p.name}</div>`)
      .join('');
    if (state.hostId === myId) {
      startBtn.classList.remove('hidden');
      waitMsg.classList.add('hidden');
    } else {
      startBtn.classList.add('hidden');
      waitMsg.classList.remove('hidden');
    }
  } else {
    lobbyOverlay.classList.add('hidden');
  }

  // Update top status text & dash cooldown
  if (state.status === 'roundOver') {
    statusDisplay.textContent = `Winner: ${state.winner}`;
  } else if (state.status === 'playing') {
    const aliveCount = state.players.filter((p) => p.alive).length;
    statusDisplay.textContent = `Alive: ${aliveCount}/${state.players.length}`;
  }

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    dashBtn.disabled = me.cooldown > 0 || !me.alive;
    dashBtn.textContent = me.cooldown > 0 ? me.cooldown.toFixed(1) : 'DASH';
  }

  drawArena(state);
});

function drawArena(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Auto-scale so the full arena fits any phone screen size
  const minScreen = Math.min(canvas.width, canvas.height);
  const scale = (minScreen * 0.85) / (380 * 2);

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);

  // Draw Safe Platform
  ctx.beginPath();
  ctx.arc(0, 0, state.arenaRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#1e2436';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = state.arenaRadius < 160 ? '#ff4d4d' : '#4da6ff';
  ctx.stroke();

  // Draw Each Player
  state.players.forEach((p) => {
    if (!p.alive) return;

    // Spawn shield ring
    if (p.shield) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Player circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.dashing ? '#ffffff' : p.color;
    ctx.fill();

    // Player number inside circle
    ctx.fillStyle = '#0e131a';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.num, p.x, p.y);

    // Name & Score above circle
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px sans-serif';
    ctx.fillText(`${p.name} (${p.score})`, p.x, p.y - p.r - 10);
  });

  ctx.restore();
}
