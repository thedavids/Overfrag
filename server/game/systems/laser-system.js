// laser-system.js
import * as THREE from 'three';
import { segmentSphereIntersect } from '../math-utils.js';
import { EventBus } from '../shared/event-bus.js';

export function createLaserSystem() {
    const activeLasers = {}; // roomId → [laser objects]
    const tempRaycaster = new THREE.Raycaster();
    const tempMesh = new THREE.Mesh(); // Set geometry per room

    function spawnLaser(roomId, shooterId, origin, direction, id) {
        const now = Date.now();
        const laser = {
            id,
            shooterId,
            origin,
            direction,
            position: { ...origin },
            life: 2000,
            speed: 100,
            lastUpdate: now,
            justSpawned: true
        };

        if (!activeLasers[roomId]) activeLasers[roomId] = [];
        activeLasers[roomId].push(laser);

        EventBus.emit("laserSystem:laserFired", { roomId, shooterId, origin, direction, id });
    }

    function updateLasers(deltaTime, getRooms, getBVHGeometry) {
        const now = Date.now();

        for (const roomId in activeLasers) {
            const lasers = activeLasers[roomId];
            const room = getRooms()[roomId];
            if (!room || !lasers) continue;

            const players = room.players;
            let tempMesh = getBVHGeometry(room.map);

            for (let i = lasers.length - 1; i >= 0; i--) {
                const laser = lasers[i];
                if (laser.justSpawned) {
                    laser.justSpawned = false;
                    continue;
                }

                laser.life -= deltaTime;
                laser.lastUpdate = now;

                const moveDistance = (laser.speed * deltaTime) / 1000;
                if (!laser.prevPosition) laser.prevPosition = { x: 0, y: 0, z: 0 };
                laser.prevPosition.x = laser.position.x;
                laser.prevPosition.y = laser.position.y;
                laser.prevPosition.z = laser.position.z;
                laser.position.x += laser.direction.x * moveDistance;
                laser.position.y += laser.direction.y * moveDistance;
                laser.position.z += laser.direction.z * moveDistance;

                // Check wall collisions
                tempRaycaster.ray.origin.set(
                    laser.prevPosition.x,
                    laser.prevPosition.y,
                    laser.prevPosition.z
                );
                tempRaycaster.ray.direction.set(
                    laser.direction.x,
                    laser.direction.y,
                    laser.direction.z
                ).normalize();
                tempRaycaster.far = moveDistance;

                const hits = tempRaycaster.intersectObject(tempMesh, true);
                if (hits.length > 0) {
                    EventBus.emit("laserSystem:laserBlocked", { roomId, id: laser.id, position: laser.position });
                    lasers.splice(i, 1);
                    continue;
                }

                // Check player collisions
                const radius = 0.6;
                let hitId = null;
                let hitPlayer = null;

                for (const [pid, player] of Object.entries(players)) {
                    if (pid === laser.shooterId) continue;

                    const hit = segmentSphereIntersect(
                        laser.prevPosition,
                        laser.position,
                        player.position,
                        radius
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
                                EventBus.emit("playerDied", { roomId, playerId: hitId, shooterId: laser.shooterId, message: "blasted" });
                            }
                        }

                        break;
                    }
                }

                if (hitId || laser.life <= 0) {
                    lasers.splice(i, 1);
                    if (hitId) {
                        EventBus.emit("laserSystem:laserHit", {
                            roomId,
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
    }

    function removePlayerLasers(roomId, playerId) {
        if (activeLasers[roomId]) {
            activeLasers[roomId] = activeLasers[roomId].filter(l => l.shooterId !== playerId);
        }
    }

    function clearRoom(roomId) {
        delete activeLasers[roomId];
    }

    EventBus.on("roomsSystem:playerDisconnected", ({ roomId, socketId }) => {
        removePlayerLasers(roomId, socketId);
    });

    EventBus.on("roomsSystem:roomDeleted", ({ roomId }) => {
        clearRoom(roomId);
    });

    return {
        spawnLaser,
        updateLasers
    };
}
