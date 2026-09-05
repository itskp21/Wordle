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
  const { players, solved, guesses, word, code } = room;
  if (players.length < 2) return;

  const allDone = players.every(pid => solved[pid] !== undefined);
  if (!allDone) return;

  room.status = 'finished';

  const p1 = players[0];
  const p2 = players[1];
  const p1Solved = solved[p1] === true;
  const p2Solved = solved[p2] === true;

  let winnerSocket = null;
  if (p1Solved && p2Solved) {
    const p1Count = guesses[p1].length;
    const p2Count = guesses[p2].length;
    winnerSocket = p1Count <= p2Count ? p1 : p2;
    if (p1Count === p2Count) winnerSocket = null; // tie
  } else if (p1Solved) {
    winnerSocket = p1;
  } else if (p2Solved) {
    winnerSocket = p2;
  }

  players.forEach(pid => {
    const opponent = players.find(p => p !== pid);
    io.to(pid).emit('game-over', {
      result: winnerSocket === null ? 'tie' : winnerSocket === pid ? 'win' : 'lose',
      word,
      myGuesses: guesses[pid].length,
      opponentGuesses: opponent ? guesses[opponent].length : 0,
      mySolved: solved[pid] === true,
      opponentSolved: opponent ? solved[opponent] === true : false
    });
  });
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────────────────────────
  socket.on('create-room', ({ nickname }) => {
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));

    const word = getRandomWord();
    const room = {
      code: roomCode,
      word,
      players: [socket.id],
      nicknames: { [socket.id]: nickname || 'Player 1' },
      status: 'waiting',
      guesses: { [socket.id]: [] },
      solved: {},
      rematchVotes: new Set(),
      startTime: null
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-created', { roomCode, playerId: socket.id });
    console.log(`[Room] Created: ${roomCode} by ${socket.id}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, nickname }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.status !== 'waiting') {
      socket.emit('join-error', { message: 'That game has already started.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('join-error', { message: 'Room is full (max 2 players).' });
      return;
    }
    if (room.players.includes(socket.id)) {
      socket.emit('join-error', { message: 'You are already in this room.' });
      return;
    }

    room.players.push(socket.id);
    room.nicknames[socket.id] = nickname || 'Player 2';
    room.guesses[socket.id] = [];

    socket.join(code);
    socket.roomCode = code;

    const p1 = room.players[0];
    const p2 = socket.id;

    // Tell both players who's who
    socket.emit('room-joined', {
      roomCode: code,
      playerId: socket.id,
      opponentName: room.nicknames[p1]
    });
    io.to(p1).emit('opponent-joined', {
      opponentName: room.nicknames[p2]
    });

    console.log(`[Room] ${socket.id} joined ${code}`);

    // Start countdown
    setTimeout(() => startCountdown(room), 500);
  });

  // ── SUBMIT GUESS ─────────────────────────────────────────────────────────────
  socket.on('submit-guess', ({ guess }) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;
    if (room.solved[socket.id] !== undefined) return; // already done

    const guessUpper = (guess || '').toUpperCase().trim();
    if (guessUpper.length !== 5) return;

    if (!isValidWord(guessUpper)) {
      socket.emit('invalid-word');
      return;
    }

    const colors = calculateColors(guessUpper, room.word);
    const rowIndex = room.guesses[socket.id].length;
    room.guesses[socket.id].push({ guess: guessUpper, colors });

    const isSolved = colors.every(c => c === 'correct');
    const isExhausted = room.guesses[socket.id].length >= 6;

    // Full result to guesser (letters + colors)
    socket.emit('guess-result', { guess: guessUpper, colors, row: rowIndex, solved: isSolved });

    // Opponent only sees colors (keeps it competitive)
    socket.to(roomCode).emit('opponent-guess', { colors, row: rowIndex, solved: isSolved });

    if (isSolved) {
      room.solved[socket.id] = true;
      checkGameOver(room);
    } else if (isExhausted) {
      room.solved[socket.id] = false;
      checkGameOver(room);
    }
  });

  // ── REMATCH ──────────────────────────────────────────────────────────────────
  socket.on('request-rematch', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'finished') return;

    room.rematchVotes.add(socket.id);
    socket.to(roomCode).emit('rematch-vote');

    if (room.rematchVotes.size >= 2) {
      // Reset and start again
      room.word = getRandomWord();
      room.status = 'waiting';
      room.guesses = {};
      room.solved = {};
      room.rematchVotes = new Set();
      room.players.forEach(pid => { room.guesses[pid] = []; });
      setTimeout(() => startCountdown(room), 500);
    }
  });

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
