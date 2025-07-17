import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createShotgunSystem({ cameraSystem, effectSystem }) {
    const COOLDOWN = 1200; // ms
    const PELLET_COUNT = 8;
    const SPREAD_ANGLE = 10; // degrees
    let lastFired = 0;
    const raycaster = new THREE.Raycaster();

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function shoot() {
        if (!gameState.roomId || !gameState.playerObj) return;

        const now = Date.now();
        if (now - lastFired < COOLDOWN) return;
        lastFired = now;

        const { point: targetPoint } = cameraSystem.getCrosshairTarget(gameState.octree, 30);

        const baseDirection = targetPoint.clone()
            .sub(gameState.playerObj.position)
            .normalize();

        const muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0)) // chest height
            .add(baseDirection.clone().multiplyScalar(1.5));

        effectSystem.spawnMuzzleFlash(muzzle, baseDirection);

        for (let i = 0; i < PELLET_COUNT; i++) {
            const dir = baseDirection.clone();

            const axis = new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize();
            const angle = THREE.MathUtils.degToRad((Math.random() - 0.5) * SPREAD_ANGLE);
            dir.applyAxisAngle(axis, angle).normalize();

            performVisualRay(muzzle, dir, true);
        }

        EventBus.emit("player:shotgunFire", {
            roomId: gameState.roomId,
            origin: muzzle,
            direction: baseDirection.clone()
        });
    }

    function performVisualRay(origin, direction, showImpact = true) {
        const maxDistance = 30;
        const candidates = gameState.octree.queryRay(origin, direction, maxDistance);

        raycaster.set(origin, direction);
        raycaster.far = maxDistance;

        if (showImpact) {
            const hits = raycaster.intersectObjects(candidates, true);
            if (hits.length > 0) {
                const hit = hits[0];
                const point = hit.point;
                const normal = hit.face?.normal || direction.clone().negate();
                effectSystem.spawnHitEffect(point, normal);
            }
        }

        effectSystem.spawnTracer(origin, direction);

        EventBus.emit("shotgunFired", {
            roomId: gameState.roomId,
            origin: origin,
            direction: direction
        });
    }

    function handleBlocked({ shooterId, origin, direction }) {
        if (!origin || !direction) return;
        if (shooterId !== gameState.playerId) {
            const from = new THREE.Vector3(origin.x, origin.y, origin.z);
            const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
            performVisualRay(from, dir, true);
        }
    }

    function handleHit({ shooterId, targetId, position, origin, direction, health, damage }) {
        if (!origin || !direction) return;
        const from = new THREE.Vector3(origin.x, origin.y, origin.z);
        const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();

        if (shooterId !== gameState.playerId) {
            performVisualRay(from, dir, false);
        }

        EventBus.emit("player:healthChanged", { playerId: targetId, health });
        EventBus.emit("player:tookDamage", { position, health, damage });
    }

    return {
        shoot,
        handleBlocked,
        handleHit
    };
}
