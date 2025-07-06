import http from 'http';
import { Server } from 'socket.io';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import * as THREE from 'three';
import * as MathUtils from './math-utils.js';
import * as MapUtils from './map-utils.js';
import { EventBus } from './shared/event-bus.js';

import { createLaserSystem } from './systems/laser-system.js';
import { createMachineGunSystem } from './systems/machinegun-system.js';
import { createShotgunSystem } from './systems/shotgun-system.js';
import { createRocketSystem } from './systems/rocket-system.js';
import { createHealthPacksSystem } from './systems/healthpacks-system.js';
import { createRoomsSystem } from './systems/rooms-system.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const server = http.createServer();
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

process.on("uncaughtException", err => {
    console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("UNHANDLED PROMISE:", reason);
});

// laserSystem
const laserSystem = createLaserSystem();

EventBus.on("laserSystem:laserFired", ({ roomId, shooterId, origin, direction, id }) => {
    io.to(roomId).emit('laserFired', { shooterId, origin, direction, id });
});

EventBus.on("laserSystem:laserHit", ({ roomId, shooterId, targetId, position, health, damage }) => {
    io.to(roomId).emit('laserHit', { shooterId, targetId, position, health, damage });
});

EventBus.on("laserSystem:laserBlocked", ({ roomId, id, position }) => {
    io.to(roomId).emit('laserBlocked', { id, position });
});

// machinegunSystem
const machinegunSystem = createMachineGunSystem();

EventBus.on("machinegunSystem:machinegunHit", ({ roomId, shooterId, targetId, position, origin, direction, health, damage }) => {
    io.to(roomId).emit("machinegunHit", { shooterId, targetId, position, origin, direction, health, damage });
});

EventBus.on("machinegunSystem:machinegunBlocked", ({ roomId, shooterId, origin, direction }) => {
    io.to(roomId).emit("machinegunBlocked", { shooterId, origin, direction });
});

// shotgunSystem
const shotgunSystem = createShotgunSystem();

EventBus.on("shotgunSystem:shotgunBlocked", ({ roomId, shooterId, origin, direction }) => {
    io.to(roomId).emit('shotgunBlocked', { shooterId, origin, direction });
});

EventBus.on("shotgunSystem:shotgunHit", ({ roomId, shooterId, targetId, position, origin, direction, health, damage }) => {
    io.to(roomId).emit("shotgunHit", { shooterId, targetId, position, origin, direction, health, damage });
});

// rocketSystem
const rocketSystem = createRocketSystem();

EventBus.on("rocketSystem:rocketLaunched", ({ roomId, id, shooterId, origin, direction, position }) => {
    io.to(roomId).emit('rocketLaunched', { id, shooterId, origin, direction, position });
});

EventBus.on("rocketSystem:rocketHit", ({ roomId, shooterId, targetId, position, health, damage }) => {
    io.to(roomId).emit("rocketHit", { shooterId, targetId, position, health, damage });
});

EventBus.on("rocketSystem:rocketExploded", ({ roomId, id, position }) => {
    io.to(roomId).emit("rocketExploded", { id, position });
});

// healthPacksSystem
const healthPacksSystem = createHealthPacksSystem();

EventBus.on("healthPacksSystem:healthPackTaken", ({ roomId, id, targetPlayerId, health }) => {
    io.to(roomId).emit("healthPackTaken", { id, targetPlayerId, health });
});

EventBus.on("healthPacksSystem:healthPackRespawned", ({ roomId, id }) => {
    io.to(roomId).emit("healthPackRespawned", { id });
});

// roomsSystem
const roomsSystem = createRoomsSystem({ mapUtils: MapUtils });

EventBus.on("roomsSystem:playerDisconnected", ({ roomId, socketId, name }) => {
    io.to(roomId).emit('serverMessage', { message: `${name} left the game.` });
    io.to(roomId).emit('playerDisconnected', socketId);
    console.log(`Client disconnected: ${name} ${socketId}`);
});

EventBus.on("roomsSystem:roomDeleted", ({ roomId }) => {
    console.warn("Room deleted:", roomId);
});

EventBus.on("serverMessage", ({ roomId, message }) => {
    io.to(roomId).emit('serverMessage', { message });
});

EventBus.on("playerDied", ({ roomId, playerId, shooterId, message }) => {
    respawnPlayer(roomId, playerId, shooterId, message);
});

// socket setup
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('getMaps', (callback) => {
        const availableMaps = MapUtils.getAvailableMaps();
        callback(availableMaps);
    });

    socket.on('getRooms', (callback) => {
        const availableRooms = roomsSystem.getRoomsByIdAndPlayersCount();
        callback(availableRooms);
    });

    socket.on('createRoom', async ({ name, modelName, mapName }, callback) => {

        if (typeof name !== 'string' || typeof modelName !== 'string') {
            return callback({ error: 'Invalid input' });
        }

        const { roomId, safeName, safeModel, map } = await roomsSystem.createRoom({ name, modelName, mapName });

        roomsSystem.addPlayer(roomId, socket.id, {
            name: safeName,
            modelName: safeModel
        });

        socket.join(roomId);
        socket.emit("loadMap", MapUtils.toClientMap(map));
        callback({ roomId, health: 100 });

        const room = roomsSystem.getRooms()[roomId];
        io.to(roomId).emit('playerList', room.players);
    });

    socket.on('joinRoom', ({ roomId, name, modelName }, callback) => {
        if (!roomsSystem.hasRoom(roomId)) return callback({ error: 'Room not found' });

        if (typeof name !== 'string' || typeof modelName !== 'string') {
            return callback({ error: 'Invalid input' });
        }

        const safeName = name.trim().substring(0, 64).replace(/[^\w\s-]/g, '');
        const safeModel = modelName.trim().substring(0, 64).replace(/[^\w.-]/g, '');

        roomsSystem.addPlayer(roomId, socket.id, {
            name: safeName,
            modelName: safeModel
        });

        socket.join(roomId);

        const room = roomsSystem.getRooms()[roomId];
        socket.emit("loadMap", MapUtils.toClientMap(room.map));
        callback({ success: true, health: 100 });

        io.to(roomId).emit('playerList', room.players);
        EventBus.emit("serverMessage", { roomId, message: `${safeName} joined the game.` });
    });

    socket.on("heartbeat", () => {
        roomsSystem.setLastSeen(socket.id);
        socket.emit("heartbeatAck");
    });

    socket.on('move', ({ roomId, position, rotation, isIdle, isGrounded }) => {
        if (!roomId || !position) return;
        const room = roomsSystem.getRooms()[roomId];
        if (!room || !room.players[socket.id]) return;

        room.players[socket.id].position = position;
        room.players[socket.id].rotation = rotation;

        socket.to(roomId).emit('playerMoved', {
            id: socket.id,
            position,
            rotation,
            isIdle,
            isGrounded
        });
        healthPacksSystem.tryPickupHealthPack(roomId, room, socket.id);

        if (position.y < -100 && room.players[socket.id].health > 0 && !room.players[socket.id].isDead) {
            room.players[socket.id].health = 0;
            room.players[socket.id].isDead = true;
            respawnPlayer(roomId, socket.id, socket.id, 'fell to his death', 100);
        }
    });

    socket.on('shoot', ({ roomId, origin, direction, id }) => {
        // Validate input
        if (!roomId || !origin || !direction || typeof id !== 'string') return;
        const room = roomsSystem.getRooms()[roomId];
        if (!room || !room.players[socket.id]) return;

        laserSystem.spawnLaser(roomId, socket.id, origin, direction, id);
    });

    socket.on("machinegunFire", ({ roomId, origin, direction }) => {
        // Validate input
        if (!roomId || !origin || !direction) return;
        const room = roomsSystem.getRooms()[roomId];
        if (!room || !room.players[socket.id]) return;

        machinegunSystem.fire({ roomId, room, shooterId: socket.id, origin, direction }, map => map.bvhMesh);
    });

    socket.on("shotgunFire", ({ roomId, origin, direction }) => {
        // Validate input
        if (!roomId || !origin || !direction) return;
        const room = roomsSystem.getRooms()[roomId];
        if (!room || !room.players[socket.id]) return;

        shotgunSystem.fire({ roomId, room, shooterId: socket.id, origin, direction }, map => map.bvhMesh);
    });

    socket.on('launchRocket', ({ roomId, origin, direction, id }) => {
        if (!roomId || !origin || !direction || typeof id !== 'string') return;
        const room = roomsSystem.getRooms()[roomId];
        if (!room || !room.players[socket.id]) return;

        rocketSystem.launchRocket(roomId, id, socket.id, origin, direction, { ...origin });
    });

    socket.on('disconnect', () => {
        roomsSystem.removePlayer(socket.id);
    });

    socket.on('grappleStart', ({ roomId, origin, direction }) => {
        socket.to(roomId).emit('remoteGrappleStart', {
            playerId: socket.id,
            origin,
            direction
        });
    });

    socket.on('grappleEnd', ({ roomId }) => {
        socket.to(roomId).emit('remoteGrappleEnd', {
            playerId: socket.id
        });
    });
});

// server side game loop
let tickRate = 60; // target ticks per second
let intervalId = null;
let avgTickTime = 0;
let smoothing = 0.1; // exponential moving average

// Accumulators
let cleanupElapsed = 0;
let statsElapsed = 0;

const cleanupInterval = 60000; // 60s
const statsInterval = 30000;   // 30s

let lastTimestamp = performance.now();
let tickCount = 0;
let prevCpuUsage = process.cpuUsage();

function mainLoop() {
    if (intervalId) clearInterval(intervalId);

    intervalId = setInterval(() => {
        const now = performance.now();
        const delta = now - lastTimestamp;
        lastTimestamp = now;

        // Main tick logic
        const tickStart = performance.now();
        laserSystem.updateLasers(1000 / tickRate, roomsSystem.getRooms, m => m.bvhMesh);
        rocketSystem.updateRockets(1000 / tickRate, roomsSystem.getRooms, m => m.bvhMesh);
        const tickDuration = performance.now() - tickStart;

        avgTickTime = smoothing * tickDuration + (1 - smoothing) * avgTickTime;

        cleanupElapsed += delta;
        statsElapsed += delta;
        tickCount++;

        // Periodic cleanup
        if (cleanupElapsed >= cleanupInterval) {
            roomsSystem.cleanupInactivePlayers(cleanupInterval, io);
            cleanupElapsed = 0;
        }

        // Periodic stats logging
        if (statsElapsed >= statsInterval) {
            const currentCpu = process.cpuUsage(prevCpuUsage); // delta since last snapshot
            const mem = process.memoryUsage().rss;

            const totalCpuMicros = currentCpu.user + currentCpu.system;
            const avgCpuMsPerTick = totalCpuMicros / tickCount / 1000;

            console.log(`Ticks: ${tickCount}, Avg CPU: ${avgCpuMsPerTick.toFixed(2)}ms, RAM: ${(mem / 1024 / 1024).toFixed(1)} MB`);

            // Reset
            statsElapsed = 0;
            tickCount = 0;
            prevCpuUsage = process.cpuUsage();
        }

        // Adapt tick rate if needed
        adaptTickRate();

    }, 1000 / tickRate);
}

function adaptTickRate() {
    if (avgTickTime > 16 && tickRate > 30) {
        console.warn(`High tick time (${avgTickTime.toFixed(2)}ms) — lowering tick rate`);
        tickRate = Math.max(30, tickRate - 10);
        mainLoop(); // restart with new rate
    }
    else if (avgTickTime < 10 && tickRate < 60) {
        console.log(`Low tick time (${avgTickTime.toFixed(2)}ms) — raising tick rate`);
        tickRate = Math.min(60, tickRate + 10);
        mainLoop(); // restart with new rate
    }
}

// Start loop
mainLoop();

function respawnPlayer(roomId, playerId, shooterId, action, timer = 1000) {

    const room = roomsSystem.getRooms()[roomId];
    if (!room || !room.players[playerId]) return;

    // Notify player (so they can update UI and visuals)
    io.to(roomId).emit('playerDied', {
        playerId: playerId,
        position: { x: room.players[playerId].position.x, y: room.players[playerId].position.y, z: room.players[playerId].position.z },
        message: shooterId !== playerId ?
            `${room.players[shooterId].name} ${action} ${room.players[playerId].name}` :
            `${room.players[playerId].name} ${action}`
    });

    // Reset data after delay
    setTimeout(() => {

        if (room.players[playerId] == null) {
            roomsSystem.removePlayer(playerId);
            return;
        }

        const spawnPosition = { x: 0, y: 0, z: 0 }; // change as needed
        room.players[playerId].position = spawnPosition;
        room.players[playerId].health = 100;
        room.players[playerId].isDead = false;

        // Notify player (so they can update UI and visuals)
        io.to(roomId).emit('respawn', {
            playerId: playerId,
            position: spawnPosition,
            health: 100
        });

        // Also notify other players about position reset
        io.to(roomId).emit('playerMoved', {
            id: playerId,
            position: spawnPosition,
            rotation: { x: 0, y: 0, z: 0 },
            isIdle: true,
            isGrounded: true
        });
    }, timer);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});