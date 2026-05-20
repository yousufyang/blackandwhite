const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || process.argv[2]) || 8080;
const RECONNECT_TIMEOUT = 120000; // 2 minutes to reconnect

// HTTP server for static files
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

const rooms = new Map();       // roomId -> Room
const waitingQueue = [];       // players waiting for random match

class Room {
  constructor(id) {
    this.id = id;
    this.players = [];         // [{ws, color, id, disconnected}]
    this.board = null;
    this.currentTurn = 1;      // BLACK=1 goes first
    this.started = false;
    this.scores = [0, 0];
    this.rematchVotes = new Set();
    this.reconnectTimer = null;
  }

  addPlayer(ws, playerId) {
    if (this.players.length >= 2) return false;
    const color = this.players.length === 0 ? 1 : 2;
    const idx = this.players.length;
    this.players.push({ ws, color, id: playerId, disconnected: false });
    this._bindWs(ws, idx);

    ws.send(JSON.stringify({
      type: 'joined',
      roomId: this.id,
      color,
      playerCount: this.players.length,
      playerId
    }));

    if (this.players.length === 2) {
      this.startGame();
    }
    return true;
  }

  handleReconnect(ws, playerId) {
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx === -1) return false;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const player = this.players[idx];
    player.ws = ws;
    player.disconnected = false;
    this._bindWs(ws, idx);

    // Send current state to reconnected player
    ws.send(JSON.stringify({
      type: 'rejoin_success',
      roomId: this.id,
      color: player.color,
      playerIdx: idx,
      board: this.board,
      currentTurn: this.currentTurn,
      started: this.started,
      scores: this.scores,
      gameOver: this.board ? this._isGameOver() : false
    }));

    // Notify opponent
    const opponent = this.players[1 - idx];
    if (opponent && !opponent.disconnected) {
      opponent.ws.send(JSON.stringify({ type: 'opponent_reconnected' }));
    }

    return true;
  }

  _bindWs(ws, idx) {
    ws._roomId = this.id;
    ws._color = this.players[idx].color;
    ws._playerIdx = idx;
    ws._playerId = this.players[idx].id;
  }

  _isGameOver() {
    if (!this.board) return false;
    return getValidMoves(this.board, 1).length === 0 && getValidMoves(this.board, 2).length === 0;
  }

  startGame() {
    this.started = true;
    this.board = createInitialBoard();
    this.currentTurn = 1;
    this.rematchVotes.clear();

    for (const p of this.players) {
      if (!p.disconnected) {
        p.ws.send(JSON.stringify({
          type: 'start',
          board: this.board,
          yourColor: p.color,
          currentTurn: this.currentTurn,
          scores: this.scores
        }));
      }
    }
  }

  handleMove(ws, r, c) {
    const player = this.players.find(p => p.ws === ws);
    if (!player || player.color !== this.currentTurn) return;

    const flips = getFlips(this.board, r, c, player.color);
    if (flips.length === 0) return;

    this.board[r][c] = player.color;
    for (const [fr, fc] of flips) {
      this.board[fr][fc] = player.color;
    }

    this.currentTurn = this.currentTurn === 1 ? 2 : 1;

    const nextMoves = getValidMoves(this.board, this.currentTurn);
    const oppMoves = getValidMoves(this.board, this.currentTurn === 1 ? 2 : 1);

    let gameOver = false;
    let skipped = false;

    if (nextMoves.length === 0) {
      if (oppMoves.length === 0) {
        gameOver = true;
      } else {
        this.currentTurn = this.currentTurn === 1 ? 2 : 1;
        skipped = true;
      }
    }

    const counts = countDiscs(this.board);

    for (const p of this.players) {
      if (!p.disconnected) {
        p.ws.send(JSON.stringify({
          type: 'move',
          r, c, flips,
          board: this.board,
          currentTurn: this.currentTurn,
          counts, gameOver, skipped
        }));
      }
    }

    if (gameOver) {
      let winner = -1;
      if (counts.black > counts.white) winner = this.players.findIndex(p => p.color === 1);
      else if (counts.white > counts.black) winner = this.players.findIndex(p => p.color === 2);
      if (winner >= 0) this.scores[winner]++;

      for (const p of this.players) {
        if (!p.disconnected) {
          p.ws.send(JSON.stringify({
            type: 'gameover', counts,
            scores: this.scores, winnerIdx: winner
          }));
        }
      }
    }
  }

  handleSurrender(ws) {
    if (!this.started || this.players.length < 2) return;
    const loserIdx = ws._playerIdx;
    const winnerIdx = 1 - loserIdx;
    this.scores[winnerIdx]++;

    const counts = countDiscs(this.board);
    for (const p of this.players) {
      if (!p.disconnected) {
        p.ws.send(JSON.stringify({
          type: 'gameover', counts,
          scores: this.scores, winnerIdx,
          surrendered: true, surrenderPlayer: loserIdx
        }));
      }
    }
  }

  handleRematch(ws) {
    if (this.players.length < 2) return;
    this.rematchVotes.add(ws._playerIdx);

    for (const p of this.players) {
      if (!p.disconnected) {
        p.ws.send(JSON.stringify({
          type: 'rematch_vote',
          votedPlayer: ws._playerIdx,
          votes: this.rematchVotes.size
        }));
      }
    }

    if (this.rematchVotes.size === 2) {
      for (const p of this.players) {
        p.color = p.color === 1 ? 2 : 1;
        if (p.ws) p.ws._color = p.color;
      }
      this.startGame();
    }
  }

  handleDisconnect(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;

    this.players[idx].disconnected = true;
    this.players[idx].ws = null;

    // Notify opponent
    const opponent = this.players[1 - idx];
    if (opponent && !opponent.disconnected) {
      opponent.ws.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }

    // Keep room alive for reconnection
    this.reconnectTimer = setTimeout(() => {
      this._cleanup();
    }, RECONNECT_TIMEOUT);
  }

  _cleanup() {
    // If any player is still connected, notify them
    for (const p of this.players) {
      if (!p.disconnected && p.ws) {
        p.ws.send(JSON.stringify({ type: 'opponent_left', scores: this.scores }));
      }
    }
    rooms.delete(this.id);
  }

  removePlayer(ws) {
    // Called when player explicitly leaves (backToMode)
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;

    this.players[idx].disconnected = true;
    this.players[idx].ws = null;

    const opponent = this.players[1 - idx];
    if (opponent && !opponent.disconnected) {
      opponent.ws.send(JSON.stringify({ type: 'opponent_left', scores: this.scores }));
    }
    rooms.delete(this.id);
  }
}

function createInitialBoard() {
  const bd = Array.from({length: 8}, () => Array(8).fill(0));
  bd[3][3] = 2; bd[3][4] = 1;
  bd[4][3] = 1; bd[4][4] = 2;
  return bd;
}

const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function getFlips(bd, r, c, player) {
  if (bd[r][c] !== 0) return [];
  const opp = player === 1 ? 2 : 1;
  let allFlips = [];
  for (const [dr, dc] of DIRS) {
    let flips = [];
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc) && bd[nr][nc] === opp) {
      flips.push([nr, nc]);
      nr += dr; nc += dc;
    }
    if (flips.length > 0 && inBounds(nr, nc) && bd[nr][nc] === player) {
      allFlips.push(...flips);
    }
  }
  return allFlips;
}

function getValidMoves(bd, player) {
  const moves = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (getFlips(bd, r, c, player).length > 0) moves.push({r, c});
  return moves;
}

function countDiscs(bd) {
  let black = 0, white = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      if (bd[r][c] === 1) black++;
      else if (bd[r][c] === 2) white++;
    }
  return { black, white };
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

wss.on('connection', (ws) => {
  console.log('Player connected');

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const playerId = msg.playerId || crypto.randomUUID();
        const roomId = generateRoomId();
        const room = new Room(roomId);
        rooms.set(roomId, room);
        room.addPlayer(ws, playerId);
        console.log(`Room ${roomId} created`);
        break;
      }

      case 'join_room': {
        const playerId = msg.playerId || crypto.randomUUID();
        const room = rooms.get(msg.roomId?.toUpperCase());
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' }));
        } else if (room.players.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', msg: '房间已满' }));
        } else {
          room.addPlayer(ws, playerId);
          console.log(`Player joined room ${room.id}`);
        }
        break;
      }

      case 'rejoin': {
        const room = rooms.get(msg.roomId);
        if (room && room.handleReconnect(ws, msg.playerId)) {
          console.log(`Player rejoined room ${msg.roomId}`);
        } else {
          ws.send(JSON.stringify({ type: 'rejoin_failed' }));
        }
        break;
      }

      case 'random_match': {
        const playerId = msg.playerId || crypto.randomUUID();
        const idx = waitingQueue.findIndex(q => q.ws === ws);
        if (idx !== -1) break;

        let matched = false;
        for (const [rid, room] of rooms) {
          if (room.players.length === 1 && !room.started && !room.players[0].disconnected) {
            room.addPlayer(ws, playerId);
            console.log(`Random match: joined room ${rid}`);
            matched = true;
            break;
          }
        }

        if (!matched) {
          if (waitingQueue.length > 0) {
            const other = waitingQueue.shift();
            if (other.ws.readyState === 1) {
              const roomId = generateRoomId();
              const room = new Room(roomId);
              rooms.set(roomId, room);
              room.addPlayer(other.ws, other.playerId);
              room.addPlayer(ws, playerId);
              console.log(`Random match: room ${roomId}`);
            } else {
              waitingQueue.push({ ws, playerId });
              ws.send(JSON.stringify({ type: 'waiting', msg: '正在匹配对手...' }));
            }
          } else {
            let hasWaitingRoom = false;
            for (const [, room] of rooms) {
              if (room.players.length === 1 && !room.players[0].disconnected) { hasWaitingRoom = true; break; }
            }
            if (!hasWaitingRoom) {
              ws.send(JSON.stringify({ type: 'error', msg: '当前没有等待中的房间，请先创建房间或稍后再试' }));
            } else {
              waitingQueue.push({ ws, playerId });
              ws.send(JSON.stringify({ type: 'waiting', msg: '正在匹配对手...' }));
            }
          }
        }
        break;
      }

      case 'cancel_match': {
        const i = waitingQueue.findIndex(q => q.ws === ws);
        if (i !== -1) waitingQueue.splice(i, 1);
        ws.send(JSON.stringify({ type: 'cancelled' }));
        break;
      }

      case 'move': {
        const room = rooms.get(ws._roomId);
        if (room) room.handleMove(ws, msg.r, msg.c);
        break;
      }

      case 'rematch': {
        const room = rooms.get(ws._roomId);
        if (room) room.handleRematch(ws);
        break;
      }

      case 'surrender': {
        const room = rooms.get(ws._roomId);
        if (room) room.handleSurrender(ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    const i = waitingQueue.findIndex(q => q.ws === ws);
    if (i !== -1) waitingQueue.splice(i, 1);

    const room = rooms.get(ws._roomId);
    if (room) room.handleDisconnect(ws);
    console.log('Player disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`黑白棋服务器运行中: http://localhost:${PORT}`);
});
