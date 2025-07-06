import * as THREE from 'three';
import * as MathUtils from '../math-utils.js';
import { EventBus } from '../shared/event-bus.js';

export function createShotgunSystem() {
    const PELLET_COUNT = 8;
    const MAX_RANGE = 50;
    const BASE_SPREAD_ANGLE = 10;
    const MIN_SPREAD_ANGLE = 0;
    const MAX_EFFECTIVE_DISTANCE = 15;

    function computeShotgunDamage(distance) {
        if (distance < 15) return 5;
        if (distance < 25) return 4;
        if (distance < 50) return 2;
        return 0;
    }

    function getSpreadDirection(baseDir, spreadAngleDeg, downwardBias = 3) {
        const spreadAngleRad = THREE.MathUtils.degToRad(spreadAngleDeg);
        const randomAngle = Math.random() * 2 * Math.PI;
        const randomRadius = Math.random() * Math.tan(spreadAngleRad);

        const dir = MathUtils.toVector3(baseDir).clone().normalize();
        const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const right = new THREE.Vector3().crossVectors(up, dir).normalize();
        const upOrtho = new THREE.Vector3().crossVectors(dir, right).normalize();

        const offset = right.multiplyScalar(Math.cos(randomAngle) * randomRadius)
            .add(upOrtho.multiplyScalar(Math.sin(randomAngle) * randomRadius * (1 + downwardBias)));

        return dir.clone().add(offset).normalize();
    }

    function fire({ roomId, room, shooterId, origin, direction }, getBVHGeometry) {

        let closestPlayerDist = Infinity;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === shooterId) continue;

            const toPlayer = {
                x: player.position.x - origin.x,
                y: player.position.y - origin.y,
                z: player.position.z - origin.z
            };

            const dirNorm = MathUtils.normalizeVec3(direction);
            const dot = toPlayer.x * dirNorm.x + toPlayer.y * dirNorm.y + toPlayer.z * dirNorm.z;
            if (dot <= 0) continue;

            const dist = dot;
            if (dist < closestPlayerDist) {
                closestPlayerDist = dist;
            }
        }

        const clampedDist = Math.min(closestPlayerDist, MAX_EFFECTIVE_DISTANCE);
        const t = clampedDist / MAX_EFFECTIVE_DISTANCE;
        const ease = Math.pow(t, 4.0);
        const spreadAngle = MIN_SPREAD_ANGLE + ease * (BASE_SPREAD_ANGLE - MIN_SPREAD_ANGLE);

        const hitsPerPlayer = {};
        const mesh = new THREE.Mesh(getBVHGeometry(room.map));

        for (let i = 0; i < PELLET_COUNT; i++) {
            const pelletDir = getSpreadDirection(direction, spreadAngle);
            let nearestWallDist = Infinity;
            let wallHitPos = null;

            const raycaster = new THREE.Raycaster(
                new THREE.Vector3(origin.x, origin.y, origin.z),
                new THREE.Vector3(pelletDir.x, pelletDir.y, pelletDir.z).normalize(),
                0,
                MAX_RANGE
            );

            const hits = raycaster.intersectObject(mesh, true);
            if (hits.length > 0) {
                nearestWallDist = hits[0].distance;
                wallHitPos = hits[0].point;
            }

            let hitPlayerId = null;
            let hitPlayerPos = null;

            const playerHalfSize = { x: 0.7, y: 1.6, z: 0.7 };

            for (const [pid, player] of Object.entries(room.players)) {
                if (pid === shooterId) continue;

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

                const hitDist = MathUtils.rayIntersectsAABB(origin, pelletDir, MAX_RANGE, min, max);
                if (hitDist != null && hitDist < nearestWallDist) {
                    nearestWallDist = hitDist;
                    hitPlayerId = pid;
                    hitPlayerPos = MathUtils.addVec3(origin, MathUtils.scaleVec3(pelletDir, hitDist));
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
                
                EventBus.emit("shotgunSystem:shotgunBlocked", { roomId, shooterId, origin, direction: pelletDir });
            }
        }

        for (const [targetId, { totalDamage, position }] of Object.entries(hitsPerPlayer)) {
            const victim = room.players[targetId];
            victim.health = (victim.health || 100) - totalDamage;

            EventBus.emit("shotgunSystem:shotgunHit", {
                roomId,
                shooterId,
                targetId,
                position,
                origin,
                direction,
                health: Math.max(0, victim.health),
                damage: totalDamage
            });

            if (victim.health <= 0) {
                EventBus.emit("playerDied", { roomId, playerId: targetId, shooterId, message: "shotgunned" });
            }
        }
    }

    return {
        fire
    };
}
