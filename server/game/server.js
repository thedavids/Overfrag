import http from 'http';
import { Server } from 'socket.io';
import { OctreeNode, computeMapBounds, EventBus, createMapSystem } from './shared/index.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import * as THREE from 'three';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

const rooms = {};
const playerLastSeen = {}; // { socket.id: timestamp }
const activeLasers = {}; // roomId -> [{ id, shooterId, origin, direction, position, life }]
const activeRockets = {}; // roomId -> [rocketObj]

// === MapSystem Begin ===
const maps = {
    default: { "name": "Jump Arena" },
    //road: { "name": "Road" },
    city: { "name": "City" },
    anotherCity: { "name": "Detailed City" },
    giganticCity: { "name": "Gigantic City" },
    blockTown: { "name": "Block Town" },
    //q2dm1: { "name": "Q2DM1" }
};

export async function loadMap(name = "default") {
    try {
        const filePath = path.join(__dirname, 'maps', `${name}.json`);
        const fileData = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(fileData);
    } catch (err) {
        console.error(`❌ Failed to load map '${name}':`, err.message);
        return null;
    }
}

async function prepareMap(name) {
    const map = await loadMap(name);

    if (map.bvh && Array.isArray(map.bvh)) {
        const allGeometries = map.bvh.map(part => {
            const geometry = new THREE.BufferGeometry();

            // === Position ===
            const posBuffer = base64ToArrayBuffer(part.position);
            const posArray = new Float32Array(posBuffer, 0, part.count * 3);
            const posAttr = new THREE.Float32BufferAttribute(posArray, 3);
            geometry.setAttribute('position', posAttr);

            // === Index (if any) ===
            if (part.index) {
                const idxBuffer = base64ToArrayBuffer(part.index);
                const IndexArrayType = (part.indexType === 'Uint16Array') ? Uint16Array : Uint32Array;

                const expectedBytes = part.indexCount * IndexArrayType.BYTES_PER_ELEMENT;
                if (idxBuffer.byteLength < expectedBytes) {
                    console.warn('⚠️ Index buffer too small:', {
                        expected: expectedBytes,
                        actual: idxBuffer.byteLength,
                        part
                    });
                    return null;
                }

                const idxArray = new IndexArrayType(idxBuffer, 0, part.indexCount);
                geometry.setIndex(new THREE.BufferAttribute(idxArray, 1));
            }

            return geometry;
        }).filter(Boolean);
        const mergedGeometry = mergeGeometries(allGeometries, false);
        mergedGeometry.boundsTree = new MeshBVH(mergedGeometry);

        map.bvhMesh = mergedGeometry;
    }

    return map;
}
// === MapSystem End ===

function distanceVec3(a, b) {
    return Math.sqrt(
        (a.x - b.x) ** 2 +
        (a.y - b.y) ** 2 +
        (a.z - b.z) ** 2
    );
}

function vec3({ x, y, z }) {
    return { x, y, z };
}

function subtractVec3(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function addVec3(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVec3(a, s) {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dotVec3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalizeVec3(v) {
    const length = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) || 1;
    return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function segmentSphereIntersect(p1, p2, center, radius) {
    const d = subtractVec3(p2, p1); // segment direction
    const f = subtractVec3(p1, center); // from center to segment start

    const a = dotVec3(d, d);
    const b = 2 * dotVec3(f, d);
    const c = dotVec3(f, f) - radius * radius;

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return false;

    const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
    const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);

    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

function getAABB(obj) {
    const cx = obj.center?.x ?? obj.position.x;
    const cy = obj.center?.y ?? obj.position.y;
    const cz = obj.center?.z ?? obj.position.z;
    const half = {
        x: obj.size[0] / 2,
        y: obj.size[1] / 2,
        z: obj.size[2] / 2,
    };

    return {
        center: [cx, cy, cz],
        size: obj.size,
        min: { x: cx - half.x, y: cy - half.y, z: cz - half.z },
        max: { x: cx + half.x, y: cy + half.y, z: cz + half.z },
    };
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const buffer = new ArrayBuffer(len);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < len; i++) {
        view[i] = binary.charCodeAt(i);
    }
    return buffer;
}

function rayIntersectsAABB(origin, dir, maxDist, min, max) {
    let tmin = (min.x - origin.x) / dir.x;
    let tmax = (max.x - origin.x) / dir.x;
    if (tmin > tmax) [tmin, tmax] = [tmax, tmin];

    let tymin = (min.y - origin.y) / dir.y;
    let tymax = (max.y - origin.y) / dir.y;
    if (tymin > tymax) [tymin, tymax] = [tymax, tymin];

    if ((tmin > tymax) || (tymin > tmax)) return null;
    if (tymin > tmin) tmin = tymin;
    if (tymax < tmax) tmax = tymax;

    let tzmin = (min.z - origin.z) / dir.z;
    let tzmax = (max.z - origin.z) / dir.z;
    if (tzmin > tzmax) [tzmin, tzmax] = [tzmax, tzmin];

    if ((tmin > tzmax) || (tzmin > tmax)) return null;

    const hitDist = Math.max(tmin, tzmin);
    return (hitDist >= 0 && hitDist <= maxDist) ? hitDist : null;
}

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    playerLastSeen[socket.id] = Date.now();

    socket.on('getMaps', (callback) => {
        const availableMaps = Object.entries(maps).map(([id, map]) => ({
            id,
            name: map?.name || id
        }));
        callback(availableMaps);
    });

    socket.on('getRooms', (callback) => {
        const availableRooms = Object.entries(rooms).map(([id, room]) => ({
            id,
            count: Object.keys(room.players).length
        }));
        callback(availableRooms);
    });

    socket.on('createRoom', async ({ name, modelName, mapName }, callback) => {

        // Basic input validation
        if (typeof name !== 'string' || typeof modelName !== 'string') {
            return callback({ error: 'Invalid input' });
        }

        // Trim and limit length and allow only basic alphanumeric, dashes, underscores, and spaces
        name = name.trim().substring(0, 64);
        modelName = modelName.trim().substring(0, 64);
        const safeName = name.replace(/[^\w\s-]/g, '');
        const safeModel = modelName.replace(/[^\w.-]/g, '');
        const roomId = `room-${Math.random().toString(36).substr(2, 6)}`;

        let mapNameToLoad = safeName.toLowerCase() === 'q2dm1' ? safeName.toLowerCase() : (mapName || 'default');
        if (!maps[mapNameToLoad] || !maps[mapNameToLoad].objects) {
            maps[mapNameToLoad] = await prepareMap(mapNameToLoad);
        }
        const map = maps[mapNameToLoad];

        rooms[roomId] = {
            players: {},
            map
        };

        socket.join(roomId);
        rooms[roomId].players[socket.id] = { name: safeName, position: { x: 0, y: 0, z: 0 }, health: 100, modelName: safeModel };
        console.warn(`Player ${safeName} created room`, socket.id);
        socket.emit("loadMap", rooms[roomId].map);
        callback({ roomId, health: 100 });
        io.to(roomId).emit('playerList', rooms[roomId].players);
    });

    socket.on('joinRoom', ({ roomId, name, modelName }, callback) => {
        if (!rooms[roomId]) return callback({ error: 'Room not found' });

        // Basic input validation
        if (typeof name !== 'string' || typeof modelName !== 'string') {
            return callback({ error: 'Invalid input' });
        }

        // Trim and limit length and allow only basic alphanumeric, dashes, underscores, and spaces
        name = name.trim().substring(0, 64);
        modelName = modelName.trim().substring(0, 64);
        const safeName = name.replace(/[^\w\s-]/g, '');
        const safeModel = modelName.replace(/[^\w.-]/g, '');

        socket.join(roomId);
        rooms[roomId].players[socket.id] = { name: safeName, position: { x: 0, y: 0, z: 0 }, health: 100, modelName: safeModel };
        console.warn(`Player ${safeName} joined room`, socket.id);
        socket.emit("loadMap", rooms[roomId].map);
        callback({ success: true, health: 100 });
        io.to(roomId).emit('playerList', rooms[roomId].players);
        sendMessage(roomId, safeName + ' joined the game.');
    });

    socket.on("heartbeat", () => {
        playerLastSeen[socket.id] = Date.now();
        socket.emit("heartbeatAck");
    });

    socket.on('move', (data) => {
        try {
            const { roomId, position, rotation, isIdle, isGrounded } = data;
            if (!roomId || !position) return;
            const room = rooms[roomId];
            if (room?.players[socket.id]) {
                room.players[socket.id].position = position;
                room.players[socket.id].rotation = rotation;
                socket.to(roomId).emit('playerMoved', {
                    id: socket.id,
                    position,
                    rotation,
                    isIdle,
                    isGrounded
                });
                tryPickupHealthPack(roomId, socket.id);
                if (position.y < -100 && room.players[socket.id].health > 0 && !room.players[socket.id].isDead) {
                    room.players[socket.id].health = 0;
                    room.players[socket.id].isDead = true;
                    respawnPlayer(roomId, socket.id, socket.id, 'fell to his death', 100);
                }
            }
        } catch (err) {
            console.error("Error handling move:", err);
        }
    });

    socket.on('shoot', ({ roomId, origin, direction, id }) => {
        // Validate input
        if (!roomId || !origin || !direction || typeof id !== 'string') return;

        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;

        const now = Date.now();
        const laser = {
            id,
            shooterId: socket.id,
            origin,
            direction,
            position: { ...origin },
            life: 2000, // ms to live
            speed: 100,  // units/sec
            lastUpdate: now,
            justSpawned: true
        };

        if (!activeLasers[roomId]) activeLasers[roomId] = [];
        activeLasers[roomId].push(laser);

        // Send initial fire for visuals
        io.to(roomId).emit('laserFired', {
            shooterId: socket.id,
            origin,
            direction,
            id
        });
    });

    socket.on("machinegunFire", ({ roomId, origin, direction }) => {
        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;

        const range = 100;
        let nearestWallDist = Infinity;
        let wallHitPos = null;

        // === 1. Build precise ray ===
        const raycaster = new THREE.Raycaster();
        raycaster.ray.origin.set(origin.x, origin.y, origin.z);
        raycaster.ray.direction.set(direction.x, direction.y, direction.z).normalize();
        raycaster.far = range;

        // === 2. Run intersection on full map BVH ===
        const geometry = room.map.bvhMesh;
        const mesh = new THREE.Mesh(geometry); // dummy mesh (not added to scene)

        const hits = raycaster.intersectObject(mesh, true);

        // === 3. Handle nearest hit ===
        if (hits.length > 0) {
            const hit = hits[0];
            nearestWallDist = hit.distance;
            wallHitPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        }

        // === 2. Check player hitboxes ===
        let hitPlayerId = null;
        let hitPlayerPos = null;

        const playerHalfSize = { x: 0.4, y: 0.9, z: 0.4 }; // adjust for your game

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === socket.id) continue;

            const min = {
                x: player.position.x - playerHalfSize.x,
                y: player.position.y - playerHalfSize.y,
                z: player.position.z - playerHalfSize.z
            };

            const max = {
                x: player.position.x + playerHalfSize.x,
                y: player.position.y + playerHalfSize.y,
                z: player.position.z + playerHalfSize.z
            };

            const hitDist = rayIntersectsAABB(origin, direction, range, min, max);
            if (hitDist != null && hitDist < nearestWallDist) {
                nearestWallDist = hitDist;
                hitPlayerId = pid;
                hitPlayerPos = addVec3(origin, scaleVec3(direction, hitDist));
            }
        }

        // === 3. Act on nearest hit ===
        if (hitPlayerId) {
            const victim = room.players[hitPlayerId];
            victim.health = (victim.health || 100);

            if (victim.health > 0) {
                victim.health -= 3;

                io.to(roomId).emit("machinegunHit", {
                    shooterId: socket.id,
                    targetId: hitPlayerId,
                    position: hitPlayerPos,
                    origin,
                    direction,
                    health: Math.max(0, victim.health),
                    damage: 3
                });

                if (victim.health <= 0) {
                    respawnPlayer(roomId, hitPlayerId, socket.id, "machine gunned");
                }
            }
        } else if (wallHitPos) {
            io.to(roomId).emit("machinegunBlocked", {
                shooterId: socket.id,
                origin,
                direction
            });
        }
    });

    socket.on("shotgunFire", ({ roomId, origin, direction }) => {
        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;

        const PELLET_COUNT = 8;
        const MAX_RANGE = 50;
        const BASE_SPREAD_ANGLE = 10;
        const MIN_SPREAD_ANGLE = 0;
        const MAX_EFFECTIVE_DISTANCE = 15;

        let closestPlayerDist = Infinity;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === socket.id) continue;

            const toPlayer = {
                x: player.position.x - origin.x,
                y: player.position.y - origin.y,
                z: player.position.z - origin.z
            };

            // Normalize shot direction
            const dir = normalizeVec3(direction);

            // Compute dot product
            const dot = toPlayer.x * dir.x + toPlayer.y * dir.y + toPlayer.z * dir.z;

            // If dot <= 0, player is behind the shooter — skip them
            if (dot <= 0) continue;

            // Project toPlayer vector onto the shooting direction to get distance along ray
            const dist = dot; // since dir is normalized

            if (dist < closestPlayerDist) {
                closestPlayerDist = dist;
            }
        }

        // Linearly interpolate spread angle based on distance to closest target
        const clampedDist = Math.min(closestPlayerDist, MAX_EFFECTIVE_DISTANCE);
        const t = clampedDist / MAX_EFFECTIVE_DISTANCE;
        const ease = Math.pow(t, 4.0); // more aggressive (try 2.0 for even tighter close shots)
        let spreadAngle = MIN_SPREAD_ANGLE + ease * (BASE_SPREAD_ANGLE - MIN_SPREAD_ANGLE);

        const hitsPerPlayer = {}; // accumulate damage per target

        for (let i = 0; i < PELLET_COUNT; i++) {
            const pelletDir = getSpreadDirection(direction, spreadAngle);
            let nearestWallDist = Infinity;
            let wallHitPos = null;

            // === Create raycaster for the pellet direction ===
            const raycaster = new THREE.Raycaster();
            raycaster.ray.origin.set(origin.x, origin.y, origin.z);
            raycaster.ray.direction.set(pelletDir.x, pelletDir.y, pelletDir.z).normalize();
            raycaster.far = MAX_RANGE;

            // === Use BVH-backed map geometry ===
            const geometry = room.map.bvhMesh;
            const mesh = new THREE.Mesh(geometry); // dummy mesh for raycast

            const hits = raycaster.intersectObject(mesh, true);

            // === Find nearest hit (automatically sorted by distance) ===
            if (hits.length > 0) {
                const hit = hits[0];
                nearestWallDist = hit.distance;
                wallHitPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
            }
            let hitPlayerId = null;
            let hitPlayerPos = null;

            const playerHalfSize = { x: 0.7, y: 1.6, z: 0.7 };

            for (const [pid, player] of Object.entries(room.players)) {
                if (pid === socket.id) continue;

                const min = {
                    x: player.position.x - playerHalfSize.x,
                    y: player.position.y - playerHalfSize.y,
                    z: player.position.z - playerHalfSize.z
                };

                const max = {
                    x: player.position.x + playerHalfSize.x,
                    y: player.position.y + playerHalfSize.y,
                    z: player.position.z + playerHalfSize.z
                };

                const hitDist = rayIntersectsAABB(origin, pelletDir, MAX_RANGE, min, max);
                if (hitDist != null && hitDist < nearestWallDist) {
                    nearestWallDist = hitDist;
                    hitPlayerId = pid;
                    hitPlayerPos = addVec3(origin, scaleVec3(pelletDir, hitDist));
                }
            }

            if (hitPlayerId) {
                const damage = computeShotgunDamage(nearestWallDist);
                hitsPerPlayer[hitPlayerId] = hitsPerPlayer[hitPlayerId] || {
                    totalDamage: 0,
                    position: hitPlayerPos
                };
                hitsPerPlayer[hitPlayerId].totalDamage += damage;
            } else if (wallHitPos) {
                io.to(roomId).emit("shotgunBlocked", {
                    shooterId: socket.id,
                    origin,
                    direction: pelletDir
                });
            }
        }

        // Apply damage to hit players
        for (const [targetId, { totalDamage, position }] of Object.entries(hitsPerPlayer)) {
            const victim = room.players[targetId];
            victim.health = (victim.health || 100);

            if (victim.health > 0) {
                victim.health -= totalDamage;

                io.to(roomId).emit("shotgunHit", {
                    shooterId: socket.id,
                    targetId,
                    position,
                    origin,
                    direction,
                    health: Math.max(0, victim.health),
                    damage: totalDamage
                });

                if (victim.health <= 0) {
                    respawnPlayer(roomId, targetId, socket.id, "shotgunned");
                }
            }

        }
    });

    socket.on('launchRocket', ({ roomId, origin, direction, id }) => {
        if (!roomId || !origin || !direction || typeof id !== 'string') return;

        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;

        const now = Date.now();
        const rocket = {
            id,
            shooterId: socket.id,
            origin,
            direction,
            position: { ...origin },
            speed: 30,     // slower than laser
            life: 10000,    // ms
            radius: 5,     // explosion radius
            damage: 35,
            lastUpdate: now,
            justSpawned: true
        };

        if (!activeRockets[roomId]) activeRockets[roomId] = [];
        activeRockets[roomId].push(rocket);

        io.to(roomId).emit('rocketLaunched', {
            shooterId: socket.id,
            origin,
            direction,
            id
        });
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
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

function handleDisconnect(socket) {
    for (const roomId in rooms) {
        if (rooms[roomId].players[socket.id]) {
            if (activeLasers[roomId]) {
                activeLasers[roomId] = activeLasers[roomId].filter(l => l.shooterId !== socket.id);
            }
            if (activeRockets[roomId]) {
                activeRockets[roomId] = activeRockets[roomId].filter(l => l.shooterId !== socket.id);
            }
            const name = rooms[roomId].players[socket.id].name;
            sendMessage(roomId, name + ' left the game.');
            delete rooms[roomId].players[socket.id];
            io.to(roomId).emit('playerDisconnected', socket.id);
            console.log(`Client disconnected: ${name} ${socket.id}`);
            if (Object.keys(rooms[roomId].players).length === 0) {
                delete activeLasers[roomId];
                delete activeRockets[roomId];
                delete rooms[roomId];
                console.warn("Room deleted", roomId);
            }
            break;
        }
    }
    delete playerLastSeen[socket.id];
}

setInterval(() => {
    const now = Date.now();
    for (const id in playerLastSeen) {
        if (now - playerLastSeen[id] > 300000) {
            const sock = io.sockets.sockets.get(id);
            if (sock) {
                console.warn("Client timeout disconnecting:", id);
                handleDisconnect(sock);
                sock.disconnect(); // optional
            } else {
                cleanupStalePlayer(id); // fallback
            }
        }
    }
}, 30000);

function cleanupStalePlayer(id) {
    for (const roomId in rooms) {
        if (rooms[roomId].players[id]) {
            const name = rooms[roomId].players[id].name;
            delete rooms[roomId].players[id];
            sendMessage(roomId, name + ' left the game.');
            io.to(roomId).emit('playerDisconnected', id);
            console.log(`Client disconnected: ${name} ${id}`);
            if (Object.keys(rooms[roomId].players).length === 0) {
                delete activeLasers[roomId];
                delete activeRockets[roomId];
                delete rooms[roomId];
                console.warn("Room deleted (stale cleanup):", roomId);
            }
            break;
        }
    }
    delete playerLastSeen[id];
}

function respawnPlayer(roomId, playerId, shooterId, action, timer = 1000) {
    const room = rooms[roomId];
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
            cleanupStalePlayer(playerId);
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

function updateRoomLasers(roomId) {
    const now = Date.now();

    const lasers = activeLasers[roomId];
    const room = rooms[roomId];
    if (!room || !lasers) return;

    for (let i = lasers.length - 1; i >= 0; i--) {
        const laser = lasers[i];
        const delta = now - (laser.lastUpdate || now); // milliseconds since last update
        if (laser.justSpawned) {
            laser.justSpawned = false;
            continue; // skip this frame
        }

        laser.life -= delta;
        laser.lastUpdate = now;

        const moveDistance = (laser.speed * delta) / 1000;

        // Track previous position for swept collision
        laser.prevPosition = { ...laser.position };

        let blocked = false;

        const raycaster = new THREE.Raycaster();
        raycaster.ray.origin.set(
            laser.prevPosition.x,
            laser.prevPosition.y,
            laser.prevPosition.z
        );
        raycaster.ray.direction.set(
            laser.direction.x,
            laser.direction.y,
            laser.direction.z
        ).normalize();
        raycaster.far = moveDistance;

        const geometry = room.map.bvhMesh;
        const mesh = new THREE.Mesh(geometry); // dummy mesh for raycasting

        const hits = raycaster.intersectObject(mesh, true);

        if (hits.length > 0) {
            blocked = true;
        }

        if (blocked) {
            // Inform all players so they can remove the laser visually
            io.to(roomId).emit('laserBlocked', {
                id: laser.id,
                position: laser.position
            });

            lasers.splice(i, 1);
            continue; // skip player hit checks
        }

        // Move laser forward
        laser.position.x += laser.direction.x * moveDistance;
        laser.position.y += laser.direction.y * moveDistance;
        laser.position.z += laser.direction.z * moveDistance;

        // Check for hit
        const hitRadius = 0.6;
        let hitId = null;
        let hitPlayer = null;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === laser.shooterId) continue;

            // Swept hit detection (segment-sphere)
            const hit = segmentSphereIntersect(
                laser.prevPosition,
                laser.position,
                player.position,
                hitRadius
            );

            if (hit) {
                hitId = pid;
                hitPlayer = player;

                if (typeof hitPlayer.health !== 'number') {
                    hitPlayer.health = 100;
                }

                if (hitPlayer.health > 0) {
                    hitPlayer.health -= 10;
                    if (hitPlayer.health <= 0) {
                        respawnPlayer(roomId, hitId, laser.shooterId, 'blasted');
                    }
                }
                break;
            }
        }

        if (hitId || laser.life <= 0) {
            // Remove laser
            lasers.splice(i, 1);

            // Inform clients
            if (hitId) {
                io.to(roomId).emit('laserHit', {
                    shooterId: laser.shooterId,
                    targetId: hitId,
                    position: laser.position,
                    health: hitPlayer.health,
                    damage: 10
                });
            }
        }
    }
}

function updateRoomRockets(roomId) {
    const rockets = activeRockets[roomId];
    const room = rooms[roomId];
    if (!room || !rockets) return;

    const now = Date.now();

    for (let i = rockets.length - 1; i >= 0; i--) {
        const rocket = rockets[i];
        const delta = now - (rocket.lastUpdate || now);
        if (rocket.justSpawned) {
            rocket.justSpawned = false;
            continue; // skip this frame
        }

        rocket.life -= delta;
        rocket.lastUpdate = now;

        const moveDistance = (rocket.speed * delta) / 1000;
        rocket.prevPosition = { ...rocket.position };

        rocket.position.x += rocket.direction.x * moveDistance;
        rocket.position.y += rocket.direction.y * moveDistance;
        rocket.position.z += rocket.direction.z * moveDistance;

        let hitWall = false;
        let hitPlayerId = null;
        let explosionPos = { ...rocket.position };

        // === 1. Check for direct player hit ===
        const hitRadius = 0.8;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === rocket.shooterId) continue;

            const hit = segmentSphereIntersect(
                rocket.prevPosition,
                rocket.position,
                player.position,
                hitRadius
            );

            if (hit) {
                hitPlayerId = pid;
                explosionPos = { ...player.position }; // explode at player center
                break;
            }
        }

        // === 2. Check for wall collision ===
        const ray = new THREE.Ray(
            new THREE.Vector3(rocket.prevPosition.x, rocket.prevPosition.y, rocket.prevPosition.z),
            new THREE.Vector3(rocket.direction.x, rocket.direction.y, rocket.direction.z).normalize()
        );

        // Optional: limit to rocket travel distance
        const raycaster = new THREE.Raycaster();
        raycaster.ray = ray;
        raycaster.far = moveDistance;

        // Use the merged geometry + BVH
        const geometry = room.map.bvhMesh;
        const dummyMesh = new THREE.Mesh(geometry); // no need to add to scene
        const hits = raycaster.intersectObject(dummyMesh, true);
        if (hits.length > 0) {
            hitWall = true;
        }

        // === 3. Should detonate? ===
        const detonated = hitWall || hitPlayerId !== null || rocket.life <= 0;

        if (detonated) {
            rockets.splice(i, 1); // remove rocket

            // === 4. Apply AoE damage ===
            for (const [pid, player] of Object.entries(room.players)) {
                const dist = distanceVec3(player.position, explosionPos);

                if (dist <= rocket.radius) {
                    let damage = 0;
                    if (pid !== rocket.shooterId) {
                        damage = Math.round((1 - dist / rocket.radius) * rocket.damage);
                        player.health = (player.health || 100) - damage;

                        if (player.health <= 0) {
                            respawnPlayer(roomId, pid, rocket.shooterId, "was rocketed");
                        }
                    }

                    io.to(roomId).emit('rocketHit', {
                        shooterId: rocket.shooterId,
                        targetId: pid,
                        position: explosionPos,
                        health: Math.max(0, player.health),
                        damage
                    });
                }
            }

            // === 5. Notify explosion visual ===
            io.to(roomId).emit('rocketExploded', {
                id: rocket.id,
                position: explosionPos
            });
        }
    }
}

setInterval(() => {
    for (const roomId in activeLasers) {
        if (activeLasers[roomId]?.length > 0) {
            updateRoomLasers(roomId);
        }
    }
    for (const roomId in activeRockets) {
        if (activeRockets[roomId]?.length > 0) {
            updateRoomRockets(roomId);
        }
    }
}, 1000 / 60); // 60 FPS

function computeShotgunDamage(distance) {
    if (distance < 15) return 5;
    if (distance < 25) return 4;
    if (distance < 50) return 2;
    return 0;
}

function toVector3(obj) {
    return new THREE.Vector3(obj.x, obj.y, obj.z);
}

function getSpreadDirection(baseDir, spreadAngleDeg, downwardBias = 3) {
    const spreadAngleRad = THREE.MathUtils.degToRad(spreadAngleDeg);
    const randomAngle = Math.random() * 2 * Math.PI;
    const randomRadius = Math.random() * Math.tan(spreadAngleRad);

    // Base direction (normalized)
    const dir = toVector3(baseDir).clone().normalize();

    // Create an orthonormal basis around baseDir
    const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const upOrtho = new THREE.Vector3().crossVectors(dir, right).normalize();

    // Add downward bias by scaling upOrtho slightly more negative
    const offset = right.multiplyScalar(Math.cos(randomAngle) * randomRadius)
        .add(upOrtho.multiplyScalar(Math.sin(randomAngle) * randomRadius * (1 + downwardBias)));

    const spreadDir = dir.clone().add(offset).normalize();
    return spreadDir;
}

function sendMessage(roomId, message) {
    io.to(roomId).emit('serverMessage', {
        message: message
    });
}

function tryPickupHealthPack(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[playerId];
    if (!player) return;

    for (const pack of room.map.healthPacks) {
        if (!pack.available) continue;

        const dx = player.position.x - pack.position.x;
        const dy = player.position.y - pack.position.y;
        const dz = player.position.z - pack.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < 2.0) {
            pack.available = false;
            player.health = Math.min(100, (player.health || 100) + 25);

            io.to(roomId).emit("healthPackTaken", {
                id: pack.id,
                targetPlayerId: playerId,
                health: player.health
            });

            setTimeout(() => {
                pack.available = true;
                io.to(roomId).emit("healthPackRespawned", { id: pack.id });
            }, 10000);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});