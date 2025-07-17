import http from 'http';
import express from 'express';
import { Server } from 'socket.io';

import { acceleratedRaycast } from 'three-mesh-bvh';
import * as THREE from 'three';

import * as MapUtils from './map-utils.js';
import { EventBus } from './shared/event-bus.js';
import { createLaserSystem } from './systems/laser-system.js';
import { createMachineGunSystem } from './systems/machinegun-system.js';
import { createShotgunSystem } from './systems/shotgun-system.js';
import { createRocketSystem } from './systems/rocket-system.js';
import { createRailGunSystem } from './systems/railgun-system.js';
import { createHealthPacksSystem } from './systems/healthpacks-system.js';
import { createRoomsSystem } from './systems/rooms-system.js';
import { createInstancesSystem } from './systems/instances-system.js';
import { createBotsSystem } from './systems/bots-system.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

process.on("uncaughtException", err => {
    console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("UNHANDLED PROMISE:", reason);
});

const PLAYER_HEALTH = 200;

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

// railgunSystem
const railgunSystem = createRailGunSystem();

EventBus.on("railgunSystem:railgunBlocked", ({ roomId, shooterId, origin, direction }) => {
    io.to(roomId).emit('railgunBlocked', { shooterId, origin, direction });
});

EventBus.on("railgunSystem:railgunHit", ({ roomId, shooterId, targetId, position, origin, direction, health, damage }) => {
    io.to(roomId).emit("railgunHit", { shooterId, targetId, position, origin, direction, health, damage });
});

// healthPacksSystem
const healthPacksSystem = createHealthPacksSystem();

EventBus.on("healthPacksSystem:healthPackTaken", ({ roomId, id, targetPlayerId, health }) => {
    io.to(roomId).emit("healthPackTaken", { id, targetPlayerId, health });
});

EventBus.on("healthPacksSystem:healthPackRespawned", ({ roomId, id }) => {
    io.to(roomId).emit("healthPackRespawned", { id });
});

// bots system
const botsSystem = createBotsSystem({ laserSystem, machinegunSystem, health: PLAYER_HEALTH });

EventBus.on("botsSystem:moved", ({ botId, room, position, rotation, isIdle, isGrounded }) => {
    if (!position || !room.players) return;
    const player = room.players[botId];
    if (!player) return;

    player.position = position;
    player.rotation = rotation;

    io.to(room.id).emit('playerMoved', {
        id: botId,
        position,
        rotation,
        isIdle,
        isGrounded,
        isBot: true
    });

    healthPacksSystem.tryPickupHealthPack(room.id, room, botId);

    if (position.y < -100 && player.health > 0 && !player.isDead) {
        respawnPlayer(room.id, botId, botId, 'fell to his death', 100);
    }
});

// roomsSystem
const roomsSystem = createRoomsSystem({ mapUtils: MapUtils, botsSystem });

EventBus.on("roomsSystem:playerConnected", ({ roomId, socketId, name }) => {
    if (instancesSystem.isLobby() === false) {
        instancesSystem.reportToLobby('player-joined', { roomId, playerId: socketId, isLobby: instancesSystem.isLobby() });
    }
    io.to(roomId).emit('serverMessage', { roomId, message: `${name} joined the game.` });
    console.log(`[GAME] Client ${name} connected to room ${roomId}: ${socketId}`);
});

EventBus.on("roomsSystem:playerDisconnected", ({ roomId, socketId, name }) => {
    if (instancesSystem.isLobby() === false) {
        instancesSystem.reportToLobby('player-left', { roomId, playerId: socketId, isLobby: instancesSystem.isLobby() });
    }
    io.to(roomId).emit('serverMessage', { message: `${name} left the game.` });
    io.to(roomId).emit('playerDisconnected', socketId);
    console.log(`[GAME] Client ${name} disconnected from room ${roomId}: ${socketId}`);
});

EventBus.on("roomsSystem:roomDeleted", ({ roomId }) => {
    instancesSystem.deallocateRoomInstance(roomId);
    console.warn("Room deleted:", roomId);
});

EventBus.on("serverMessage", ({ roomId, message }) => {
    io.to(roomId).emit('serverMessage', { message });
});

EventBus.on("playerDied", ({ roomId, playerId, shooterId, message }) => {

    let room = roomsSystem.getRooms()[roomId];
    if (playerId !== shooterId && room?.players?.[shooterId] != null) {
        room.players[shooterId].kill++;
        const death = room.players[shooterId].death;
        room.players[shooterId].kdratio = room.players[shooterId].kill / (death <= 0 ? 1 : death);

    }
    if (room?.players?.[playerId] != null) {
        room.players[playerId].death++;
        room.players[playerId].kdratio = room.players[playerId].kill / room.players[playerId].death;
    }

    respawnPlayer(roomId, playerId, shooterId, message);
});

// instances manager
const instancesSystem = createInstancesSystem(roomsSystem);

// http end point
process.env.PORT = process.env.PORT || "3000";
const PORT = parseInt(process.env.PORT, 10);

let server = http.createServer();
if (instancesSystem.isLobby()) {
    const app = express();
    app.use(express.json());

    // Add internal POST endpoints
    app.post('/internal/player-joined', (req, res) => {
        const { roomId, playerId, isLobby } = req.body;
        if (isLobby === false) {
            roomsSystem.addPlayer(roomId, playerId, {
                name: '',
                modelName: '',
                health: PLAYER_HEALTH
            });
        }
        console.log(`[LOBBY / HTTP] Player joined: ${playerId} → ${roomId} @isLobby ${isLobby}`);
        res.sendStatus(200);
    });

    app.post('/internal/player-left', (req, res) => {
        const { roomId, playerId, isLobby } = req.body;
        roomsSystem.removePlayer(playerId);
        console.log(`[LOBBY / HTTP] Player left: ${playerId} → ${roomId} @isLobby ${isLobby}`);
        res.sendStatus(200);
    });
    server = http.createServer(app);
}
else {
    const app = express();
    app.use(express.json());
    server = http.createServer(app);
}

const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

io.on('connection', (socket) => {
    const { roomId, name, modelName, mapName, allowBots } = socket.handshake.query;

    if (roomId && name && modelName) {
        handleGameSocket(socket, roomId, name, modelName, mapName, allowBots);
    }
    else {
        handleLobbySocket(socket);
    }
});

function handleLobbySocket(socket) {
    console.log(`[LOBBY] Client connected: ${socket.id}`);

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

        const roomId = roomsSystem.generateRoomId();
        const roomUrl = await instancesSystem.allocateRoomInstance(roomId);
        if (roomUrl == null) {
            return callback({ error: 'Unable to start instance' });
        }
        await roomsSystem.createRoomLobby({ roomId, name, modelName });

        callback({ roomId, roomUrl, health: PLAYER_HEALTH });
    });

    socket.on('joinRoom', ({ roomId, name, modelName }, callback) => {
        if (!roomsSystem.hasRoom(roomId)) {
            return callback({ error: 'Room not found' });
        }

        if (typeof name !== 'string' || typeof modelName !== 'string') {
            return callback({ error: 'Invalid input' });
        }

        const roomUrl = instancesSystem.getRoomInstanceUrl(roomId);
        if (!roomUrl) {
            return callback({ error: 'Room instance not available' });
        }

        callback({ roomUrl, success: true, health: PLAYER_HEALTH });
    });
}

function rejectGameSocketConnection(socket, reason, roomId) {
    console.warn(reason, socket.id);

    instancesSystem.reportToLobby('player-left', {
        roomId,
        playerId: socket.id,
        isLobby: instancesSystem.isLobby()
    });

    socket.disconnect();
}

async function handleGameSocket(socket, roomId, name, modelName, mapName, allowBots) {
    if (!roomId || typeof name !== 'string' || typeof modelName !== 'string') {
        rejectGameSocketConnection(socket, "[GAME] Invalid room connection query", roomId);
        return;
    }

    const safeName = name.trim().substring(0, 64).replace(/[^\w\s-]/g, '');
    const safeModel = modelName.trim().substring(0, 64).replace(/[^\w.-]/g, '');

    console.log(`[GAME] Client connected ${safeName}: ${socket.id}`);

    let room = roomsSystem.getRooms()[roomId];

    if (!room || room.isLobby) {
        if (process.env.PORT != PORT) {
            rejectGameSocketConnection(socket, `[GAME] Rejected room creation on non-lobby instance for ${roomId}`, roomId);
            return;
        }

        if (typeof mapName !== 'string' || mapName == 'null') {
            rejectGameSocketConnection(socket, "[GAME] Invalid room connection query (mapName is null)", roomId);
            return;
        }

        await roomsSystem.createRoomGame({ roomId, name, modelName, mapName });
        room = roomsSystem.getRooms()[roomId];
        console.log(`[GAME] Room created: ${roomId}`);
    }

    const map = MapUtils.toClientMap(room.map);
    if (map == null) {
        rejectGameSocketConnection(socket, "[GAME] Invalid room connection query (map is null)", roomId);
        return;
    }

    socket.emit("loadMap", map);

    socket.once("mapLoaded", () => {
        socket.join(roomId);

        roomsSystem.addPlayer(roomId, socket.id, {
            name: safeName,
            modelName: safeModel,
            health: PLAYER_HEALTH
        });

        allowBots = typeof allowBots === 'string' ? allowBots.toLowerCase() === 'true' : allowBots
        if (allowBots === true) {
            const name1 = 'Mr. Dumb Red Bot';
            const name2 = 'Mr. Dumb Green Bot';
            botsSystem.spawnBot(1, name1, "Soldier1.glb", room);
            botsSystem.spawnBot(2, name2, "Soldier2.glb", room);

            io.to(roomId).emit('serverMessage', { roomId: room.id, message: `${name1} joined the game.` });
            io.to(roomId).emit('serverMessage', { roomId: room.id, message: `${name2} joined the game.` });
        }

        io.to(roomId).emit("playerList", room.players);
    });

    socket.on("heartbeat", () => {
        roomsSystem.setLastSeen(socket.id);
        socket.emit("heartbeatAck");
    });

    socket.on('move', ({ position, rotation, isIdle, isGrounded }) => {
        if (!position || !room.players) return;
        const player = room.players[socket.id];
        if (!player) return;

        player.position = position;
        player.rotation = rotation;

        /*const lagMs = Math.floor(Math.random() * 900) + 100; // Random between 100 and 1000 ms

        setTimeout(() => {
            socket.to(roomId).emit('playerMoved', {
                id: socket.id,
                position,
                rotation,
                isIdle,
                isGrounded
            });
        }, lagMs);*/

        socket.to(roomId).emit('playerMoved', {
            id: socket.id,
            position,
            rotation,
            isIdle,
            isGrounded
        });

        healthPacksSystem.tryPickupHealthPack(roomId, room, socket.id);

        if (position.y < -100 && player.health > 0 && !player.isDead) {
            respawnPlayer(roomId, socket.id, socket.id, 'fell to his death', 100);
        }
    });

    socket.on('shoot', ({ origin, direction, id }) => {
        if (!origin || !direction || typeof id !== 'string') return;
        laserSystem.spawnLaser(roomId, socket.id, origin, direction, id);
    });

    socket.on("machinegunFire", ({ origin, direction }) => {
        if (!origin || !direction) return;
        machinegunSystem.fire({ roomId, room, shooterId: socket.id, origin, direction }, map => map.bvhMesh);
    });

    socket.on("shotgunFire", ({ origin, direction }) => {
        if (!origin || !direction) return;
        shotgunSystem.fire({ roomId, room, shooterId: socket.id, origin, direction }, map => map.bvhMesh);
    });

    socket.on('launchRocket', ({ origin, direction, id }) => {
        if (!origin || !direction || typeof id !== 'string') return;
        rocketSystem.launchRocket(roomId, id, socket.id, origin, direction, { ...origin });
    });

    socket.on('railgunFire', ({ origin, direction }) => {
        if (!origin || !direction) return;
        railgunSystem.fire({ roomId, room, shooterId: socket.id, origin, direction }, map => map.bvhMesh);
    });

    socket.on('grappleStart', ({ origin, direction }) => {
        socket.to(roomId).emit('remoteGrappleStart', {
            playerId: socket.id,
            origin,
            direction
        });
    });

    socket.on('grappleAttached', ({ origin }) => {
        socket.to(roomId).emit('remoteGrappleAttached', {
            playerId: socket.id,
            origin: origin
        });
    });

    socket.on('grappleEnd', () => {
        socket.to(roomId).emit('remoteGrappleEnd', {
            playerId: socket.id
        });
    });

    socket.on('disconnect', () => {
        roomsSystem.removePlayer(socket.id);
        io.to(roomId).emit('playerDisconnected', socket.id);
    });
}

// server side game loop
let tickRate = 60; // target ticks per second
let intervalId = null;
let avgTickTime = 0;
let smoothing = 0.1; // exponential moving average

// Accumulators
let cleanupElapsed = 0;
let statsElapsed = 0;

const cleanupInterval = 90000; // 90s
const statsInterval = 60000;   // 60s

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
        laserSystem.updateLasers(delta, roomsSystem.getRooms, m => m.bvhMesh);
        rocketSystem.updateRockets(delta, roomsSystem.getRooms, m => m.bvhMesh);
        botsSystem.update(delta);
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

    if (room.players[playerId].isDead) {
        return;
    }

    room.players[playerId].health = 0;
    room.players[playerId].isDead = true;

    const stats = Object.values(room.players)
        .map(p => ({
            name: p.name,
            kill: p.kill,
            death: p.death,
            kdratio: p.kdratio
        }))
        .sort((a, b) => {
            if (b.kill !== a.kill) return b.kill - a.kill;
            return a.name.localeCompare(b.name);
        });

    // Notify player (so they can update UI and visuals)
    io.to(roomId).emit('playerDied', {
        playerId: playerId,
        position: { x: room.players[playerId].position.x, y: room.players[playerId].position.y, z: room.players[playerId].position.z },
        message: shooterId !== playerId ?
            `${room.players[shooterId].name} ${action} ${room.players[playerId].name}` :
            `${room.players[playerId].name} ${action}`,
        stats: stats
    });

    // Reset data after delay
    setTimeout(() => {

        if (room.players[playerId] == null) {
            roomsSystem.removePlayer(playerId);
            return;
        }

        const spawnPosition = { x: 0, y: 0, z: 0 }; // change as needed
        room.players[playerId].position = spawnPosition;
        room.players[playerId].health = PLAYER_HEALTH;
        room.players[playerId].isDead = false;

        // Notify player (so they can update UI and visuals)
        io.to(roomId).emit('respawn', {
            playerId: playerId,
            position: spawnPosition,
            health: PLAYER_HEALTH
        });

        EventBus.emit("player:respawned", {
            playerId,
            position: spawnPosition,
            room
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

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});