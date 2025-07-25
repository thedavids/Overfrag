import * as THREE from 'three';
import * as MathUtils from '../math-utils.js';
import { EventBus } from '../shared/event-bus.js';

export function createShotgunSystem() {
    const PELLET_COUNT = 8;
    const MAX_RANGE = 50;
    const BASE_SPREAD_ANGLE = 10;
    const MIN_SPREAD_ANGLE = 0;
    const MAX_EFFECTIVE_DISTANCE = 15;
    const tempMesh = new THREE.Mesh(); // Set geometry per room
    const tempOrigin = new THREE.Vector3();
    const tempDirection = new THREE.Vector3();
    const tempMin = new THREE.Vector3();
    const tempMax = new THREE.Vector3();
    const tempHitVec = new THREE.Vector3();
    const tempRaycaster = new THREE.Raycaster();
    const tempSpreadDir = new THREE.Vector3();
    const tempUp = new THREE.Vector3();
    const tempRight = new THREE.Vector3();
    const tempUpOrtho = new THREE.Vector3();
    const tempOffset = new THREE.Vector3();

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

        // dir = normalized baseDir
        tempSpreadDir.set(baseDir.x, baseDir.y, baseDir.z).normalize();

        // up vector
        if (Math.abs(tempSpreadDir.y) < 0.99) {
            tempUp.set(0, 1, 0);
        } else {
            tempUp.set(1, 0, 0);
        }

        // right = up × dir
        tempRight.crossVectors(tempUp, tempSpreadDir).normalize();

        // upOrtho = dir × right
        tempUpOrtho.crossVectors(tempSpreadDir, tempRight).normalize();

        // offset = right * cos(a) * r + upOrtho * sin(a) * r * (1 + downwardBias)
        tempOffset.copy(tempRight).multiplyScalar(Math.cos(randomAngle) * randomRadius)
            .add(tempUpOrtho.multiplyScalar(Math.sin(randomAngle) * randomRadius * (1 + downwardBias)));

        // final direction = dir + offset
        return tempSpreadDir.add(tempOffset).normalize().clone(); // clone if caller stores the result
    }

    function fire({ roomId, room, shooterId, origin, direction }, getBVHGeometry) {
        tempOrigin.set(origin.x, origin.y, origin.z);
        tempDirection.set(direction.x, direction.y, direction.z).normalize();

        // Spread adjustment based on closest enemy
        let closestPlayerDist = Infinity;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === shooterId) continue;

            const dx = player.position.x - origin.x;
            const dy = player.position.y - origin.y;
            const dz = player.position.z - origin.z;
            const dot = dx * tempDirection.x + dy * tempDirection.y + dz * tempDirection.z;

            if (dot > 0 && dot < closestPlayerDist) {
                closestPlayerDist = dot;
            }
        }

        const clampedDist = Math.min(closestPlayerDist, MAX_EFFECTIVE_DISTANCE);
        const spreadT = clampedDist / MAX_EFFECTIVE_DISTANCE;
        const ease = Math.pow(spreadT, 4.0);
        const spreadAngle = MIN_SPREAD_ANGLE + ease * (BASE_SPREAD_ANGLE - MIN_SPREAD_ANGLE);

        const hitsPerPlayer = {};
        let tempMesh = getBVHGeometry(room.map);

        for (let i = 0; i < PELLET_COUNT; i++) {
            const pelletDir = getSpreadDirection(direction, spreadAngle);

            tempRaycaster.set(tempOrigin, pelletDir.clone().normalize());
            tempRaycaster.far = MAX_RANGE;

            let wallHitDist = Infinity;
            let wallHitPos = null;

            const hits = tempRaycaster.intersectObject(tempMesh, true);
            if (hits.length > 0) {
                wallHitDist = hits[0].distance;
                wallHitPos = hits[0].point;
            }

            let hitPlayerId = null;
            let hitPlayerPos = null;

            for (const [pid, player] of Object.entries(room.players)) {
                if (pid === shooterId) continue;

                tempMin.set(
                    player.position.x - 0.7,
                    player.position.y - 1.6,
                    player.position.z - 0.7
                );
                tempMax.set(
                    player.position.x + 0.7,
                    player.position.y + 1.6,
                    player.position.z + 0.7
                );

                const hitDist = MathUtils.rayIntersectsAABB(origin, pelletDir, MAX_RANGE, tempMin, tempMax);
                if (hitDist != null && hitDist < wallHitDist) {
                    wallHitDist = hitDist;
                    hitPlayerId = pid;
                    hitPlayerPos = MathUtils.addVec3(origin, MathUtils.scaleVec3(pelletDir, hitDist, tempHitVec));
                }
            }

            if (hitPlayerId) {
                const damage = computeShotgunDamage(wallHitDist);
                if (!hitsPerPlayer[hitPlayerId]) {
                    hitsPerPlayer[hitPlayerId] = {
                        totalDamage: 0,
                        position: hitPlayerPos
                    };
                }
                hitsPerPlayer[hitPlayerId].totalDamage += damage;
            } else if (wallHitPos) {
                EventBus.emit("shotgunSystem:shotgunBlocked", {
                    roomId,
                    shooterId,
                    origin,
                    direction: pelletDir
                });
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
                EventBus.emit("playerDied", {
                    roomId,
                    playerId: targetId,
                    shooterId,
                    message: "shotgunned"
                });
            }
        }
    }

    return {
        fire
    };
}
