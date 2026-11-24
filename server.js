const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the website files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const COLORS = ['#FF4D4D', '#4DA6FF', '#4DFF88', '#FFD24D', '#D24DFF', '#FF944D', '#4DFFFF', '#FF66B2'];
const START_RADIUS = 380;

// Helper to generate a 4-letter room code
function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? makeRoomCode() : code;
}

// Reset all players in a room for a new round
function resetRound(room) {
  room.arenaRadius = START_RADIUS;
  room.status = 'playing';
  room.winner = null;
  const playerIds = Object.keys(room.players);

  playerIds.forEach((id, index) => {
    const angle = (index / playerIds.length) * Math.PI * 2;
    const spawnDist = START_RADIUS * 0.6;
    const p = room.players[id];
    p.x = Math.cos(angle) * spawnDist;
    p.y = Math.sin(angle) * spawnDist;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.dashCooldown = 0;
    p.dashTimer = 0;
    p.shieldTimer = 3.0; // 3 seconds of spawn protection
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  // Create a new 8-player room
  socket.on('createRoom', (playerName) => {
    const code = makeRoomCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      status: 'lobby',
      arenaRadius: START_RADIUS,
      players: {},
      winner: null
    };
    joinRoom(socket, code, playerName);
  });

  // Join an existing room
  socket.on('joinRoom', ({ code, playerName }) => {
    const cleanCode = (code || '').toUpperCase().trim();
    const room = rooms[cleanCode];
    if (!room) return socket.emit('errorMsg', 'Room not found!');
    if (Object.keys(room.players).length >= 8) return socket.emit('errorMsg', 'Room is full (max 8 players)!');
    joinRoom(socket, cleanCode, playerName);
  });

  function joinRoom(sock, code, name) {
    currentRoom = code;
    sock.join(code);
    const room = rooms[code];
    const index = Object.keys(room.players).length;

    room.players[sock.id] = {
      id: sock.id,
      num: index + 1,
      name: (name || `P${index + 1}`).slice(0, 10),
      color: COLORS[index % COLORS.length],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 22,
      alive: true,
      score: 0,
      input: { angle: 0, active: false },
      dashCooldown: 0,
      dashTimer: 0,
      shieldTimer: 0
    };

    sock.emit('joined', { code, playerId: sock.id });
    if (room.status === 'playing') {
      room.players[sock.id].alive = false; // Join as spectator until next round
    }
  }

  // Host starts the match
  socket.on('startGame', () => {
    const room = rooms[currentRoom];
    if (room && room.hostId === socket.id) {
      resetRound(room);
    }
  });

  // Receive joystick movement from a player's phone
  socket.on('input', (input) => {
    const room = rooms[currentRoom];
    if (room && room.players[socket.id]) {
      room.players[socket.id].input = input;
    }
  });

  // Receive dash button tap from a player's phone
  socket.on('dash', () => {
    const room = rooms[currentRoom];
    const p = room && room.players[socket.id];
    if (p && p.alive && p.dashCooldown <= 0 && room.status === 'playing') {
      p.dashTimer = 0.2;     // Dash lasts 0.2 seconds
      p.dashCooldown = 2.0;  // 2 second cooldown
      const speed = 620;
      p.vx = Math.cos(p.input.angle) * speed;
      p.vy = Math.sin(p.input.angle) * speed;
    }
  });

  // Handle player leaving
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.players[socket.id];
    const remainingIds = Object.keys(room.players);
    if (remainingIds.length === 0) {
      delete rooms[currentRoom];
    } else if (room.hostId === socket.id) {
      room.hostId = remainingIds[0]; // Assign new host
    }
  });
});

// Physics loop running 30 times per second
const DT = 1 / 30;
setInterval(() => {
  for (const code in rooms) {
    const room = rooms[code];
    const playerList = Object.values(room.players);

    if (room.status === 'playing') {
      // Shrink arena slowly
      if (room.arenaRadius > 80) {
        room.arenaRadius -= 8 * DT;
      }

      // Move each player
      playerList.forEach((p) => {
        if (!p.alive) return;
        if (p.dashCooldown > 0) p.dashCooldown -= DT;
        if (p.dashTimer > 0) p.dashTimer -= DT;
        if (p.shieldTimer > 0) p.shieldTimer -= DT;

        if (p.dashTimer <= 0) {
          const accel = p.input.active ? 900 : 0;
          p.vx += Math.cos(p.input.angle) * accel * DT;
          p.vy += Math.sin(p.input.angle) * accel * DT;
          // Apply friction
          p.vx *= 0.88;
          p.vy *= 0.88;
        }

        p.x += p.vx * DT;
        p.y += p.vy * DT;
      });

      // Player-to-player collisions
      for (let i = 0; i < playerList.length; i++) {
        for (let j = i + 1; j < playerList.length; j++) {
          const a = playerList[i];
          const b = playerList[j];
          if (!a.alive || !b.alive) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const minDist = a.radius + b.radius;

          if (dist < minDist && dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = minDist - dist;

            // Separate overlapping circles
            a.x -= nx * overlap * 0.5;
            a.y -= ny * overlap * 0.5;
            b.x += nx * overlap * 0.5;
            b.y += ny * overlap * 0.5;

            // Knockback boost if dashing
            const aForce = a.dashTimer > 0 ? 520 : 240;
            const bForce = b.dashTimer > 0 ? 520 : 240;

            if (b.shieldTimer <= 0) {
              b.vx += nx * aForce;
              b.vy += ny * aForce;
            }
            if (a.shieldTimer <= 0) {
              a.vx -= nx * bForce;
              a.vy -= ny * bForce;
            }
          }
        }
      }

      // Check Ring-Out elimination
      playerList.forEach((p) => {
        if (!p.alive) return;
        const distFromCenter = Math.hypot(p.x, p.y);
        if (distFromCenter > room.arenaRadius) {
          p.alive = false;
        }
      });

      // Check for round winner
      const alivePlayers = playerList.filter((p) => p.alive);
      if (playerList.length > 1 && alivePlayers.length <= 1) {
        room.status = 'roundOver';
        if (alivePlayers.length === 1) {
          alivePlayers[0].score += 1;
          room.winner = alivePlayers[0].name;
        } else {
          room.winner = 'Draw!';
        }
        // Start next round automatically after 3 seconds
        setTimeout(() => {
          if (rooms[code]) resetRound(rooms[code]);
        }, 3000);
      }
    }

    // Send game state to all phones in the room
    io.to(code).emit('state', {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      arenaRadius: room.arenaRadius,
      winner: room.winner,
      players: playerList.map((p) => ({
        id: p.id,
        num: p.num,
        name: p.name,
        color: p.color,
        x: Math.round(p.x),
        y: Math.round(p.y),
        r: p.radius,
        alive: p.alive,
        score: p.score,
        dashing: p.dashTimer > 0,
        shield: p.shieldTimer > 0,
        cooldown: Math.max(0, p.dashCooldown)
      }))
    });
  }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
