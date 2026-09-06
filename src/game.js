// ══════════════════════════════════════════════════════════════
// Wordle Duel — Client Game Logic
// ══════════════════════════════════════════════════════════════
import { io } from 'socket.io-client';

// ── STATE ──────────────────────────────────────────────────────
const state = {
  socket: null,
  roomCode: null,
  myName: 'You',
  oppName: 'Opponent',
  currentGuess: '',
  myRow: 0,
  oppRow: 0,
  gameOver: false,
  startTime: null,
  timerInterval: null,
  myGuessColors: [],   // for share result
  finishTime: null,
  keyStates: {},        // letter -> best color state
};

// ── DOM HELPERS ────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  lobby:     $('screen-lobby'),
  waiting:   $('screen-waiting'),
  countdown: $('screen-countdown'),
  game:      $('screen-game'),
  result:    $('screen-result'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

// ── TOAST ──────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'info', duration = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

// ── SOCKET SETUP ───────────────────────────────────────────────
function connectSocket() {
  // Dev: Vite proxies to localhost:3001
  // GitHub Pages: must connect to the Render backend explicitly
  // Render full-stack: connects to same origin
  const SOCKET_URL = import.meta.env.VITE_SOCKET_URL
    || (window.location.hostname.includes('github.io')
        ? 'https://wordle-09cj.onrender.com'
        : window.location.origin);
  const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    console.log('Connected:', socket.id);

    // If we have a room code in the URL, attempt auto-join
    const urlCode = new URLSearchParams(location.search).get('room');
    if (urlCode) {
      $('room-code-input').value = urlCode.toUpperCase();
    }
  });

  socket.on('connect_error', () => showToast('Connection error — is the server running?', 'error', 4000));

  // ── ROOM EVENTS ──────────────────────────────────────────────
  socket.on('room-created', ({ roomCode, isCreator }) => {
    state.roomCode = roomCode;
    state.isCreator = isCreator;
    $('display-room-code').textContent = roomCode;
    $('header-room-code').textContent = `Room: ${roomCode}`;
    updateShareURL(roomCode);
    showScreen('waiting');
  });

  socket.on('room-joined', ({ roomCode, isCreator }) => {
    state.roomCode = roomCode;
    state.isCreator = isCreator;
    $('header-room-code').textContent = `Room: ${roomCode}`;
  });

  socket.on('guesser-joined', () => {
    showToast(`Friend joined! Get ready!`, 'success');
  });

  socket.on('create-error', ({ message }) => {
    $('join-error').textContent = message;
    setTimeout(() => { $('join-error').textContent = ''; }, 4000);
  });

  socket.on('join-error', ({ message }) => {
    $('join-error').textContent = message;
    setTimeout(() => { $('join-error').textContent = ''; }, 4000);
  });

  socket.on('game-start', () => {
    initGame();
    showScreen('game');
    state.startTime = Date.now();
  });

  // ── GAMEPLAY EVENTS ───────────────────────────────────────────
  socket.on('guess-result', ({ guess, colors, row, solved }) => {
    revealRow('main-board', row, guess.split(''), colors, () => {
      updateKeyboard(guess, colors);
      state.myGuessColors.push(colors);
      $('guess-count').textContent = `${row + 1} / 5`;
      if (solved) {
        state.finishTime = (Date.now() - state.startTime);
        showToast('🎉 You got it!', 'success', 1500);
      }
    });
  });

  socket.on('invalid-word', () => {
    shakeCurrentRow();
    showToast('Not in word list', 'error', 1500);
  });

  socket.on('opponent-guess', ({ guess, colors, row, solved }) => {
    // Creator sees the letters and colors live
    revealRow('main-board', row, guess.split(''), colors, () => {
      $('guess-count').textContent = `${row + 1} / 5`;
      if (solved) showToast(`They solved it!`, 'info', 1500);
    });
  });

  // ── GAME OVER ─────────────────────────────────────────────────
  socket.on('game-over', ({ result, word, guesses, isCreator }) => {
    setTimeout(() => showResult(result, word, guesses, isCreator), 1200);
  });

  // ── DISCONNECT ────────────────────────────────────────────────
  socket.on('opponent-disconnected', () => {
    showToast('The other player disconnected 😢', 'error', 5000);
    setTimeout(() => {
      showScreen('lobby');
      resetAll();
    }, 3000);
  });
}

// ── SHARE URL ──────────────────────────────────────────────────
function updateShareURL(roomCode) {
  const url = new URL(location.href);
  url.search = `?room=${roomCode}`;
  history.replaceState({}, '', url);
}

// ── BOARD INIT ─────────────────────────────────────────────────
function createBoard(boardId) {
  const board = $(boardId);
  board.innerHTML = '';
  // 5 Rows (chances), 5 Columns (letters)
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.id = `${boardId}-tile-${row}-${col}`;
      tile.dataset.state = 'empty';
      board.appendChild(tile);
    }
  }
}

function initGame() {
  createBoard('main-board');
  state.currentGuess = '';
  state.myRow = 0;
  state.gameOver = false;
  state.keyStates = {};
  state.myGuessColors = [];
  state.finishTime = null;

  $('guess-count').textContent = '0 / 5';

  if (state.isCreator) {
    $('role-text').textContent = 'You are watching';
    $('creator-overlay').style.display = 'flex';
    $('keyboard').style.pointerEvents = 'none';
    $('keyboard').style.opacity = '0.5';
  } else {
    $('role-text').textContent = 'You are guessing';
    $('creator-overlay').style.display = 'none';
    $('keyboard').style.pointerEvents = 'auto';
    $('keyboard').style.opacity = '1';
  }

  // Reset keyboard
  document.querySelectorAll('.key[data-key]').forEach(key => {
    key.removeAttribute('data-state');
  });
}

// ── TILE REVEAL ────────────────────────────────────────────────
function revealRow(boardId, row, letters, colors, onComplete) {
  const DELAY_PER_TILE = 280;

  colors.forEach((color, col) => {
    const tile = $(`${boardId}-tile-${row}-${col}`);
    setTimeout(() => {
      if (letters[col]) tile.textContent = letters[col];
      tile.dataset.state = color;
      if (col === 4 && onComplete) {
        setTimeout(onComplete, DELAY_PER_TILE * 0.5);
      }
    }, col * DELAY_PER_TILE);
  });
}

// ── CURRENT GUESS RENDERING ────────────────────────────────────
function renderCurrentGuess() {
  if (state.isCreator) return;
  const row = state.myRow;
  for (let col = 0; col < 5; col++) {
    const tile = $(`main-board-tile-${row}-${col}`);
    if (!tile) return;
    const letter = state.currentGuess[col] || '';
    tile.textContent = letter;
    tile.dataset.state = letter ? 'tbd' : 'empty';
  }
  $('current-guess-bar').textContent = state.currentGuess;
}

function clearCurrentGuessRow() {
  if (state.isCreator) return;
  const row = state.myRow;
  for (let col = 0; col < 5; col++) {
    const tile = $(`main-board-tile-${row}-${col}`);
    if (tile) { tile.textContent = ''; tile.dataset.state = 'empty'; }
  }
}

// ── SHAKE ──────────────────────────────────────────────────────
function shakeCurrentRow() {
  if (state.isCreator) return;
  // Mark tiles in current row for shake
  for (let col = 0; col < 5; col++) {
    const tile = $(`main-board-tile-${state.myRow}-${col}`);
    if (!tile) continue;
    tile.style.animation = 'none';
    void tile.offsetWidth;
    tile.style.animation = 'shake 0.5s ease both';
    setTimeout(() => { tile.style.animation = ''; }, 600);
  }
}

// ── KEYBOARD UPDATE ────────────────────────────────────────────
const COLOR_PRIORITY = { correct: 3, present: 2, absent: 1 };

function updateKeyboard(guess, colors) {
  guess.split('').forEach((letter, i) => {
    const color = colors[i];
    const current = state.keyStates[letter];
    if (!current || (COLOR_PRIORITY[color] > COLOR_PRIORITY[current])) {
      state.keyStates[letter] = color;
      const key = document.querySelector(`.key[data-key="${letter}"]`);
      if (key) key.dataset.state = color;
    }
  });
}

// ── SUBMIT GUESS ───────────────────────────────────────────────
function submitGuess() {
  if (state.gameOver) return;
  if (state.currentGuess.length !== 5) {
    shakeCurrentRow();
    showToast('Word must be 5 letters', 'error', 1500);
    return;
  }

  state.socket.emit('submit-guess', { guess: state.currentGuess });
  // Optimistically advance row (server will confirm)
  state.myRow++;
  state.currentGuess = '';
}

// ── KEYBOARD INPUT ─────────────────────────────────────────────
function handleKey(key) {
  if (state.gameOver || state.isCreator) return;
  if (!state.startTime) return; // game not started

  if (key === 'ENTER') {
    submitGuess();
    return;
  }

  if (key === 'BACKSPACE') {
    state.currentGuess = state.currentGuess.slice(0, -1);
    renderCurrentGuess();
    return;
  }

  if (/^[A-Z]$/.test(key) && state.currentGuess.length < 5) {
    state.currentGuess += key;
    renderCurrentGuess();
  }
}

// Physical keyboard
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toUpperCase();
  if (key === 'ENTER')     { handleKey('ENTER'); return; }
  if (key === 'BACKSPACE') { handleKey('BACKSPACE'); return; }
  if (/^[A-Z]$/.test(key)) handleKey(key);
});

// On-screen keyboard
document.getElementById('keyboard').addEventListener('click', e => {
  const keyEl = e.target.closest('.key');
  if (!keyEl) return;
  handleKey(keyEl.dataset.key);
});

// ── TIMER ──────────────────────────────────────────────────────
// Removed: Timer is not needed in asymmetric challenge mode

// ── RESULT SCREEN ──────────────────────────────────────────────
function showResult(result, word, guesses, isCreator) {
  const resultTitle  = $('result-title');
  const resultIcon   = $('result-icon');
  const resultSub    = $('result-subtitle');

  const messages = {
    win:          { icon: '🏆', title: 'You Won!', sub: 'Outstanding! You cracked it!', cls: 'win' },
    lose:         { icon: '😔', title: 'You Lost', sub: 'Better luck next time!', cls: 'lose' },
    creator_won:  { icon: '🏆', title: 'They failed!', sub: 'Your friend couldn\'t guess your word.', cls: 'win' },
    guesser_won:  { icon: '😔', title: 'They got it!', sub: 'Your friend guessed your word.', cls: 'lose' },
  };

  const r = messages[result] || messages.lose;
  resultIcon.textContent   = r.icon;
  resultTitle.textContent  = r.title;
  resultTitle.className    = `result-title ${r.cls}`;
  resultSub.textContent    = r.sub;

  // Word reveal tiles
  const wordEl = $('result-word');
  wordEl.innerHTML = '';
  word.split('').forEach(letter => {
    const tile = document.createElement('div');
    tile.className = 'result-word-tile';
    tile.textContent = letter;
    wordEl.appendChild(tile);
  });

  // Stats
  $('stat-guesses').textContent = guesses || '—';

  $('rematch-status').textContent = '';
  showScreen('result');

  if (result === 'win' || result === 'creator_won') fireConfetti();
}

// ── LOBBY ACTIONS ──────────────────────────────────────────────
$('btn-create').addEventListener('click', () => {
  const customWord = $('word-input').value.trim();
  if (customWord.length !== 5) {
    showToast('Word must be 5 letters!', 'error');
    return;
  }
  state.socket.emit('create-room', { customWord });
});

$('btn-join').addEventListener('click', joinRoom);
$('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
$('room-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function joinRoom() {
  const code = $('room-code-input').value.toUpperCase().trim();
  if (!code || code.length < 4) {
    $('join-error').textContent = 'Enter a valid room code.';
    return;
  }
  state.socket.emit('join-room', { roomCode: code });
}

// ── COPY LINK ──────────────────────────────────────────────────
$('btn-copy-link').addEventListener('click', async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    $('copy-btn-text').textContent = 'Copied! ✓';
    setTimeout(() => { $('copy-btn-text').textContent = 'Copy Invite Link'; }, 2500);
  } catch {
    showToast('Copy failed — share the URL manually', 'error');
  }
});

// ── REMATCH ────────────────────────────────────────────────────
$('btn-rematch').addEventListener('click', () => {
  state.socket.emit('request-rematch');
  $('btn-rematch').disabled = true;
  $('btn-rematch').textContent = 'Waiting for opponent…';
  $('rematch-status').textContent = 'Rematch request sent!';
});

// ── SHARE RESULT ───────────────────────────────────────────────
$('btn-share-result').addEventListener('click', () => {
  const emoji = state.myGuessColors.map(row =>
    row.map(c => c === 'correct' ? '🟩' : c === 'present' ? '🟨' : '⬛').join('')
  ).join('\n');
  const text = `🟩 Wordle Duel — Room ${state.roomCode}\n\n${emoji}\n\nPlay at ${location.origin}`;
  navigator.clipboard.writeText(text).then(() => showToast('Result copied!', 'success'));
});

// ── RESET ──────────────────────────────────────────────────────
function resetGame() {
  state.currentGuess = '';
  state.myRow = 0;
  state.oppRow = 0;
  state.gameOver = false;
  state.startTime = null;
  state.myGuessColors = [];
  state.finishTime = null;
  state.keyStates = {};
  $('btn-rematch').disabled = false;
  $('btn-rematch').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.05"/></svg> Rematch`;
  clearInterval(state.timerInterval);
  $('game-timer').textContent = '0:00';
}

function resetAll() {
  resetGame();
  state.roomCode = null;
  state.myName = 'You';
  state.oppName = 'Opponent';
  history.replaceState({}, '', location.pathname);
}

// Handle countdown event when it fires again after rematch
const _origCountdown = state.socket; // will be set after connect
// We re-bind on game-start to handle rematch scenario
// (the countdown event triggers showScreen('countdown') and game-start triggers initGame)

// ── CONFETTI ───────────────────────────────────────────────────
function fireConfetti() {
  const canvas = $('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -10,
    r: Math.random() * 6 + 3,
    color: ['#7c6ef5','#3dba6d','#d4a017','#f46060','#6dd5fa','#f9a8f9'][Math.floor(Math.random() * 6)],
    vx: (Math.random() - 0.5) * 4,
    vy: Math.random() * 4 + 2,
    angle: Math.random() * 360,
    spin: (Math.random() - 0.5) * 6,
    opacity: 1
  }));

  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      if (p.y > canvas.height + 20 || p.opacity <= 0) return;
      alive = true;
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.08;
      p.angle += p.spin;
      if (p.y > canvas.height * 0.6) p.opacity -= 0.02;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.angle * Math.PI) / 180);
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    });
    if (alive) frame = requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  cancelAnimationFrame(frame);
  draw();
}

// ── INIT ───────────────────────────────────────────────────────
connectSocket();
showScreen('lobby');
