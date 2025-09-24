const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 4001;

// Animal names pool
const animals = [
    'Lion', 'Tiger', 'Bear', 'Wolf', 'Eagle', 'Fox', 'Owl', 'Deer',
    'Rabbit', 'Squirrel', 'Hawk', 'Falcon', 'Panda', 'Koala', 'Zebra',
    'Giraffe', 'Elephant', 'Rhino', 'Hippo', 'Kangaroo'
];

// Room state
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                videoUsers: new Map(),
                chatUsers: new Map(),
                messages: []
            });
        }

        const room = rooms.get(roomId);
        const availableAnimals = animals.filter(animal => 
            !Array.from(room.videoUsers.values()).includes(animal) &&
            !Array.from(room.chatUsers.values()).includes(animal)
        );

        if (availableAnimals.length === 0) {
            socket.emit('room-full');
            return;
        }

        const animalName = availableAnimals[Math.floor(Math.random() * availableAnimals.length)];
        
        if (room.videoUsers.size < 4) {
            // User can join as video participant
            room.videoUsers.set(socket.id, animalName);
            socket.join(roomId);
            
            socket.emit('joined-as-video', {
                animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name })),
                messages: room.messages
            });
            
            socket.to(roomId).emit('user-joined-video', {
                id: socket.id,
                animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name }))
            });
        } else {
            // User joins as chat-only participant
            room.chatUsers.set(socket.id, animalName);
            socket.join(roomId);
            
            socket.emit('joined-as-chat', {
                animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name })),
                messages: room.messages
            });
            
            socket.to(roomId).emit('user-joined-chat', {
                id: socket.id,
                animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name }))
            });
        }

        socket.roomId = roomId;
        socket.animalName = animalName;
    });

    socket.on('send-message', (message) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms.has(roomId)) return;

        const room = rooms.get(roomId);
        const messageData = {
            id: Date.now(),
            animalName: socket.animalName,
            message: message,
            timestamp: new Date().toLocaleTimeString()
        };

        room.messages.push(messageData);
        io.to(roomId).emit('new-message', messageData);
    });

    // --- PATCH: WebRTC signaling relay handlers ---
    socket.on('offer', (data) => {
        // data: { target, offer }
        io.to(data.target).emit('offer', {
            from: socket.id,
            offer: data.offer
        });
    });

    socket.on('answer', (data) => {
        // data: { target, answer }
        io.to(data.target).emit('answer', {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on('ice-candidate', (data) => {
        // data: { target, candidate }
        io.to(data.target).emit('ice-candidate', {
            from: socket.id,
            candidate: data.candidate
        });
    });
    // --- END PATCH ---

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms.has(roomId)) return;

        const room = rooms.get(roomId);
        
        if (room.videoUsers.has(socket.id)) {
            room.videoUsers.delete(socket.id);
            socket.to(roomId).emit('user-left-video', {
                id: socket.id,
                animalName: socket.animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name }))
            });
        } else if (room.chatUsers.has(socket.id)) {
            room.chatUsers.delete(socket.id);
            socket.to(roomId).emit('user-left-chat', {
                id: socket.id,
                animalName: socket.animalName,
                videoUsers: Array.from(room.videoUsers.entries()).map(([id, name]) => ({ id, name })),
                chatUsers: Array.from(room.chatUsers.entries()).map(([id, name]) => ({ id, name }))
            });
        }

        // Clean up empty rooms
        if (room.videoUsers.size === 0 && room.chatUsers.size === 0) {
            rooms.delete(roomId);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});