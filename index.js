import 'dotenv/config';
import http from 'node:http';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';

const PORT = Number(process.env.PORT ?? 3000);
const MONGODB_URI =  process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error('Missing MONGODB_URI in environment variables.');
}

const activeConnections = new Map();

function normalizeId(value, label) {
  if (!value || !mongoose.isValidObjectId(value)) {
    throw new Error(`${label} must be a valid MongoDB ObjectId.`);
  }

  return value;
}

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(MONGODB_URI);
}

function registerConnection(userId, socket) {
  const existingSocket = activeConnections.get(userId);

  if (existingSocket && existingSocket.readyState === existingSocket.OPEN) {
    existingSocket.close(1000, 'A new connection replaced this socket.');
  }

  activeConnections.set(userId, socket);
}

function unregisterConnection(userId, socket) {
  if (activeConnections.get(userId) === socket) {
    activeConnections.delete(userId);
  }
}

function parseMessage(rawMessage) {
  const text = rawMessage.toString();

  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function createMessagePayload(message) {
  return {
    type: 'message',
    data: {
      id: message._id ?? message.insertedId,
      senderId: message.senderId,
      receiverId: message.receiverId,
      content: message.content,
      read: message.read ?? false,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  };
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
});
const io = new SocketIOServer(server, {
  path: '/ws',
  cors: {
    origin: '*',
  },
});

io.use(async (socket, next) => {
  try {
    await connectDatabase();

    const userId = normalizeId(socket.handshake.auth?.userId ?? socket.handshake.query.userId, 'userId');
    const peerId = normalizeId(
      socket.handshake.auth?.peerId ?? socket.handshake.query.peerId ?? socket.handshake.auth?.receiverId ?? socket.handshake.query.receiverId,
      'peerId',
    );

    socket.data.userId = userId;
    socket.data.peerId = peerId;
    next();
  } catch (error) {
    next(error);
  }
});

io.on('connection', (socket) => {
  const { userId, peerId } = socket.data;

  socket.join(userId);
  registerConnection(userId, socket);

  socket.emit('connected', {
    userId,
    peerId,
  });

  socket.to(peerId).emit('peer:online', {
    userId,
    peerId,
  });

  socket.on('message:send', async (payload, ack) => {
    try {
      const incoming = typeof payload === 'string' ? parseMessage(payload) : payload ?? {};
      const content = typeof incoming.content === 'string' ? incoming.content.trim() : '';

      if (!content) {
        const response = {
          type: 'error',
          message: 'Message content is required.',
        };

        if (typeof ack === 'function') {
          ack(response);
        } else {
          socket.emit('error', response);
        }

        return;
      }

      const messageDocument = {
        senderId: userId,
        receiverId: peerId,
        content,
        read: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const messageResult = await mongoose.connection.collection('messages').insertOne(messageDocument);

      const messagePayload = createMessagePayload({
        ...messageDocument,
        insertedId: messageResult.insertedId,
      });

      socket.emit('message:sent', messagePayload.data);
      io.to(peerId).emit('message:new', messagePayload.data);

      if (typeof ack === 'function') {
        ack({
          type: 'message:sent',
          data: messagePayload.data,
        });
      }
    } catch (error) {
      const response = {
        type: 'error',
        message: error.message,
      };

      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit('error', response);
      }
    }
  });

  socket.on('disconnect', () => {
    unregisterConnection(userId, socket);
  });
});

async function startServer() {
  await connectDatabase();

  server.listen(PORT, () => {
    console.log(`Socket.IO server running on port ${PORT}`);
    console.log(`Socket.IO endpoint: http://localhost:${PORT} with path /ws`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});