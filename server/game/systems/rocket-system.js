import * as THREE from 'three';
import * as MathUtils from '../math-utils.js';
import { EventBus } from '../shared/event-bus.js';

export function createRocketSystem() {
    const activeRockets = {}; // roomId => [rocket]

    function launchRocket(roomId, id, shooterId, origin, direction, position) {
        if (!activeRockets[roomId]) activeRockets[roomId] = [];

        activeRockets[roomId].push({
            id,
            shooterId,
            origin,
            direction,
            position,
            life: 10000,
            speed: 30,
            radius: 5,
            damage: 35,
            lastUpdate: Date.now(),
            justSpawned: true
        });

        EventBus.emit("rocketSystem:rocketLaunched", { roomId, id, shooterId, origin, direction, position });
    }

    function updateRockets(deltaMs, getRooms, getBVHGeometry) {
        const now = Date.now();

        for (const roomId in activeRockets) {
            const room = getRooms()[roomId];
            if (!room) continue;

            const rockets = activeRockets[roomId];

            for (let i = rockets.length - 1; i >= 0; i--) {
                const rocket = rockets[i];
                if (rocket.justSpawned) {
                    rocket.justSpawned = false;
                    continue;
                }

                rocket.life -= deltaMs;
                rocket.lastUpdate = now;

                const moveDist = rocket.speed * (deltaMs / 1000);
                rocket.prevPosition = { ...rocket.position };

                rocket.position.x += rocket.direction.x * moveDist;
                rocket.position.y += rocket.direction.y * moveDist;
                rocket.position.z += rocket.direction.z * moveDist;

                let hitWall = false;
                let hitPlayerId = null;
                let explosionPos = { ...rocket.position };

                // Check player hits
                for (const [pid, player] of Object.entries(room.players)) {
                    if (pid === rocket.shooterId) continue;

                    const hit = MathUtils.segmentSphereIntersect(
                        rocket.prevPosition,
                        rocket.position,
                        player.position,
                        0.8
                    );

                    if (hit) {
                        hitPlayerId = pid;
                        explosionPos = { ...player.position };
                        break;
                    }
                }

                // Check wall hit
                const ray = new THREE.Ray(
                    new THREE.Vector3(rocket.prevPosition.x, rocket.prevPosition.y, rocket.prevPosition.z),
                    new THREE.Vector3(rocket.direction.x, rocket.direction.y, rocket.direction.z).normalize()
                );

                const raycaster = new THREE.Raycaster(ray.origin, ray.direction, 0, moveDist);
                const mesh = new THREE.Mesh(getBVHGeometry(room.map));

                const hits = raycaster.intersectObject(mesh, true);
                if (hits.length > 0) hitWall = true;

                const shouldExplode = hitWall || hitPlayerId || rocket.life <= 0;
                if (shouldExplode) {
                    rockets.splice(i, 1);

                    // Area-of-effect damage
                    for (const [pid, player] of Object.entries(room.players)) {
                        const dist = MathUtils.distanceVec3(player.position, explosionPos);

                        if (dist <= rocket.radius) {
                            let damage = 0;
                            if (pid !== rocket.shooterId) {
                                damage = Math.round((1 - dist / rocket.radius) * rocket.damage);
                                player.health = (player.health || 100) - damage;

                                if (player.health <= 0) {
                                    EventBus.emit("playerDied", { roomId, playerId: pid, shooterId: rocket.shooterId, message: "was rocketed" });
                                }
                            }

                            EventBus.emit("rocketSystem:rocketHit", {
                                roomId,
                                shooterId: rocket.shooterId,
                                targetId: pid,
                                position: explosionPos,
                                health: Math.max(0, player.health),
                                damage
                            });
                        }
                    }

                    EventBus.emit("rocketSystem:rocketExploded", { roomId, id: rocket.id, position: explosionPos });
                }
            }
        }
    }

    function removePlayerRockets(roomId, playerId) {
        if (activeRockets[roomId]) {
            activeRockets[roomId] = activeRockets[roomId].filter(l => l.shooterId !== playerId);
        }
    }

    function clearRoom(roomId) {
        delete activeRockets[roomId];
    }

    EventBus.on("roomsSystem:playerDisconnected", ({ roomId, socketId }) => {
        removePlayerRockets(roomId, socketId);
    });

    EventBus.on("roomsSystem:roomDeleted", ({ roomId }) => {
        clearRoom(roomId);
    });

    return {
        launchRocket,
        updateRockets
    };
}
