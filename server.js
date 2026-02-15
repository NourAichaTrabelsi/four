/**
 * WebSocket signaling server for one-to-one WebRTC video calls.
 * Enforces room-based access: only peers in the same room receive each other's signals.
 */

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');

// Room ID -> Set of WebSocket connections (max 2 for one-to-one)
const rooms = new Map();

// WS -> { roomId, userId }
const peerByWs = new Map();

function createServer() {
  const server = http.createServer((req, res) => {
    const filePath = req.url === '/' ? '/index.html' : req.url;
    const fullPath = path.join(PUBLIC, path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (!fullPath.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = path.extname(fullPath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let roomId = null;
    let userId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        case 'join': {
          const requestedRoom = (msg.roomId || '').trim().toLowerCase();
          if (!requestedRoom) {
            send(ws, { type: 'error', message: 'Room ID required' });
            return;
          }

          const room = rooms.get(requestedRoom) || new Set();
          if (room.size >= 2) {
            send(ws, { type: 'error', message: 'Room is full (max 2 participants)' });
            return;
          }

          userId = msg.userId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          roomId = requestedRoom;
          room.add(ws);
          rooms.set(roomId, room);
          peerByWs.set(ws, { roomId, userId });

          const peersInRoom = Array.from(room)
            .filter((w) => w !== ws)
            .map((w) => peerByWs.get(w)?.userId);

          send(ws, {
            type: 'joined',
            roomId,
            userId,
            peers: peersInRoom,
          });

          // Notify other peer(s) in the same room that someone joined (so they can create offer or expect answer)
          broadcastToRoomExcept(roomId, ws, {
            type: 'peer-joined',
            roomId,
            userId,
          });
          break;
        }

        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          if (!roomId) {
            send(ws, { type: 'error', message: 'Join a room first' });
            return;
          }
          const targetUserId = msg.to;
          const room = rooms.get(roomId);
          if (!room) return;

          const targetWs = Array.from(room).find((w) => w !== ws && peerByWs.get(w)?.userId === targetUserId);
          if (!targetWs || targetWs.readyState !== 1) {
            send(ws, { type: 'error', message: 'Peer not found or disconnected' });
            return;
          }

          // Only relay to the other peer in the same room
          send(targetWs, {
            type: msg.type,
            from: userId,
            to: targetUserId,
            sdp: msg.sdp,
            candidate: msg.candidate,
          });
          break;
        }

        case 'leave': {
          leaveRoom(ws);
          break;
        }

        default:
          send(ws, { type: 'error', message: 'Unknown message type' });
      }
    });

    ws.on('close', () => leaveRoom(ws));
  });

  function leaveRoom(ws) {
    const info = peerByWs.get(ws);
    if (!info) return;
    const { roomId, userId } = info;
    peerByWs.delete(ws);
    const room = rooms.get(roomId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(roomId);
      else {
        broadcastToRoom(roomId, { type: 'peer-left', userId });
      }
    }
  }

  function broadcastToRoom(roomId, payload) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.forEach((w) => {
      if (w.readyState === 1) send(w, payload);
    });
  }

  function broadcastToRoomExcept(roomId, excludeWs, payload) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.forEach((w) => {
      if (w !== excludeWs && w.readyState === 1) send(w, payload);
    });
  }

  function send(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  server.listen(PORT, () => {
    console.log(`Signaling server running at http://localhost:${PORT}`);
    console.log(`WebSocket path: ws://localhost:${PORT}/ws`);
  });
}

createServer();
