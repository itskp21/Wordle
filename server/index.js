const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getRandomWord, isValidWord } = require('./words');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Serve built frontend in production (for Render full-stack hosting)
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get(/^(?!\/socket\.io).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}


// rooms: Map<roomCode, RoomState>
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function calculateColors(guess, word) {
  const colors = new Array(5).fill('absent');
  const wordArr = word.split('');
  const guessArr = guess.split('');

  // Pass 1: correct positions (green)
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === wordArr[i]) {
      colors[i] = 'correct';
      wordArr[i] = null;
      guessArr[i] = null;
    }
  }

  // Pass 2: present but wrong position (yellow)
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === null) continue;
    const idx = wordArr.indexOf(guessArr[i]);
    if (idx !== -1) {
      colors[i] = 'present';
      wordArr[idx] = null;
    }
  }

  return colors;
}

function startCountdown(room) {
  room.status = 'countdown';
  let count = 3;
  io.to(room.code).emit('countdown', { count });

  const interval = setInterval(() => {
    count--;
    if (count > 0) {
      io.to(room.code).emit('countdown', { count });
    } else {
      clearInterval(interval);
      room.status = 'playing';
      room.startTime = Date.now();
      io.to(room.code).emit('game-start');
    }
  }, 1000);
}

function checkGameOver(room) {
  const { code, word, guesses, solved } = room;
  // In challenge mode, there is only one guesser.
  const isSolved = solved === true;
  const isExhausted = guesses.length >= 5;

  if (isSolved || isExhausted) {
    room.status = 'finished';
    
    // Notify Creator (if still connected)
    if (room.creator) {
      io.to(room.creator).emit('game-over', {
        result: isSolved ? 'guesser_won' : 'creator_won',
        word: word,
        guesses: guesses.length,
        isCreator: true
      });
    }

    // Notify Guesser
    if (room.guesser) {
      io.to(room.guesser).emit('game-over', {
        result: isSolved ? 'win' : 'lose',
        word: word,
        guesses: guesses.length,
        isCreator: false
      });
    }
  }
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CREATE ROOM (CREATOR) ────────────────────────────────────────────────────
  socket.on('create-room', ({ customWord }) => {
    const wordUpper = (customWord || '').toUpperCase().trim();
    if (wordUpper.length !== 5 || !isValidWord(wordUpper)) {
      socket.emit('create-error', { message: 'Invalid word. Must be a 5-letter English word.' });
      return;
    }

    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));

    const room = {
      code: roomCode,
      word: wordUpper,
      creator: socket.id,
      guesser: null,
      status: 'waiting',
      guesses: [],
      solved: false,
      startTime: null
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-created', { roomCode, isCreator: true });
    console.log(`[Room] Created: ${roomCode} by ${socket.id} (Word: ${wordUpper})`);
  });

  // ── JOIN ROOM (GUESSER) ──────────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.status !== 'waiting' && !room.guesser) {
      socket.emit('join-error', { message: 'That game has already started.' });
      return;
    }
    if (room.guesser && room.guesser !== socket.id) {
      socket.emit('join-error', { message: 'Someone is already guessing this word.' });
      return;
    }

    room.guesser = socket.id;
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room-joined', {
      roomCode: code,
      isCreator: false
    });

    if (room.creator) {
      io.to(room.creator).emit('guesser-joined');
    }

    console.log(`[Room] ${socket.id} joined ${code} as guesser`);

    // Start game immediately when guesser joins
    if (room.status === 'waiting') {
      room.status = 'playing';
      room.startTime = Date.now();
      io.to(code).emit('game-start');
    }
  });

  // ── SUBMIT GUESS (GUESSER ONLY) ──────────────────────────────────────────────
  socket.on('submit-guess', ({ guess }) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    if (socket.id !== room.guesser) return; // Only guesser can guess

    const guessUpper = (guess || '').toUpperCase().trim();
    if (guessUpper.length !== 5) return;

    if (!isValidWord(guessUpper)) {
      socket.emit('invalid-word');
      return;
    }

    const colors = calculateColors(guessUpper, room.word);
    const rowIndex = room.guesses.length;
    room.guesses.push({ guess: guessUpper, colors });

    const isSolved = colors.every(c => c === 'correct');
    if (isSolved) room.solved = true;

    // Full result to guesser (letters + colors)
    socket.emit('guess-result', { guess: guessUpper, colors, row: rowIndex, solved: isSolved });

    // Live update to Creator (sees letters + colors)
    if (room.creator) {
      io.to(room.creator).emit('opponent-guess', { guess: guessUpper, colors, row: rowIndex, solved: isSolved });
    }

    checkGameOver(room);
  });

  // ── REMATCH (NOT USED IN ASYMMETRIC MODE) ────────────────────────────────────
  // A rematch would mean a new word is needed, so players just create a new room.

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    socket.to(roomCode).emit('opponent-disconnected');

    // Clean up room after a delay (give time for reconnect in future)
    setTimeout(() => {
      if (rooms.has(roomCode)) {
        const r = rooms.get(roomCode);
        if (!r.players.some(pid => io.sockets.sockets.has(pid))) {
          rooms.delete(roomCode);
          console.log(`[Room] Cleaned up: ${roomCode}`);
        }
      }
    }, 30000);
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`\n🟩 Wordle Multiplayer Server running on http://localhost:${PORT}\n`);
});
