import * as THREE from 'three';
import * as MathUtils from '../math-utils.js';
import { EventBus } from '../shared/event-bus.js';

export function createMachineGunSystem() {
    const DAMAGE = 3;
    const RANGE = 100;
    const PLAYER_HITBOX = { x: 0.4, y: 0.9, z: 0.4 };

    function fire({ roomId, room, shooterId, origin, direction }, getBVHGeometry) {
        let nearestWallDist = Infinity;
        let wallHitPos = null;

        const raycaster = new THREE.Raycaster(
            new THREE.Vector3(origin.x, origin.y, origin.z),
            new THREE.Vector3(direction.x, direction.y, direction.z).normalize(),
            0,
            RANGE
        );

        const mesh = new THREE.Mesh(getBVHGeometry(room.map));
        const hits = raycaster.intersectObject(mesh, true);

        if (hits.length > 0) {
            nearestWallDist = hits[0].distance;
            wallHitPos = hits[0].point;
        }

        let hitPlayerId = null;
        let hitPlayerPos = null;

        for (const [pid, player] of Object.entries(room.players)) {
            if (pid === shooterId) continue;

            const min = {
                x: player.position.x - PLAYER_HITBOX.x,
                y: player.position.y - PLAYER_HITBOX.y,
                z: player.position.z - PLAYER_HITBOX.z
            };
            const max = {
                x: player.position.x + PLAYER_HITBOX.x,
                y: player.position.y + PLAYER_HITBOX.y,
                z: player.position.z + PLAYER_HITBOX.z
            };

            const hitDist = MathUtils.rayIntersectsAABB(origin, direction, RANGE, min, max);
            if (hitDist != null && hitDist < nearestWallDist) {
                nearestWallDist = hitDist;
                hitPlayerId = pid;
                hitPlayerPos = MathUtils.addVec3(origin, MathUtils.scaleVec3(direction, hitDist));
            }
        }

        if (hitPlayerId) {
            const victim = room.players[hitPlayerId];
            victim.health = (victim.health || 100) - DAMAGE;

            EventBus.emit("machinegunSystem:machinegunHit", {
                roomId,
                shooterId,
                targetId: hitPlayerId,
                position: hitPlayerPos,
                origin,
                direction,
                health: Math.max(0, victim.health),
                damage: DAMAGE
            });

            if (victim.health <= 0) {
                EventBus.emit("playerDied", { roomId, playerId: hitPlayerId, shooterId, message: "machine gunned" });
            }
        } else if (wallHitPos) {
            EventBus.emit("machinegunSystem:machinegunBlocked", { roomId, shooterId, origin, direction });
        }
    }

    return {
        fire
    };
}
