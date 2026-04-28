const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.FRONTEND_URL, methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Auth required'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.user;

    // Each user joins their private room
    socket.join(`${role}:${id}`);

    // Providers join the shared pool to receive broadcast new_job events
    if (role === 'provider') {
      socket.join('providers');
    }

    socket.on('provider:location', (data) => {
      // Provider sends GPS coords during active job
      // Broadcast to the customer on that job
      if (data.jobId && data.lat && data.lng) {
        io.to(`customer:${data.customerId}`).emit('provider:location', {
          lat: data.lat,
          lng: data.lng,
          jobId: data.jobId,
        });
      }
    });

    socket.on('disconnect', () => {
      if (role === 'provider') {
        socket.leave('providers');
      }
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { init, getIO };
