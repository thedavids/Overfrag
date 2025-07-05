import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createMachineGunSystem({ cameraSystem, effectSystem }) {
    const COOLDOWN = 100; // ms between shots
    let lastFired = 0;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function shoot() {
        if (!gameState.roomId || !gameState.playerObj) return;

        const now = Date.now();
        if (now - lastFired < COOLDOWN) return;
        lastFired = now;

        const { origin, direction: cameraDirection, point: targetPoint } = cameraSystem.getCrosshairTarget(gameState.octree, 1000);

        const forward = cameraDirection.clone();
        const muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0))
            .add(forward.clone().multiplyScalar(1.5));

        const shootDir = targetPoint.clone().sub(muzzle).normalize();

        EventBus.emit("player:machinegunFire", {
            roomId: gameState.roomId,
            origin: muzzle,
            direction: shootDir
        });

        createVisual(muzzle, shootDir, true, targetPoint);
    }

    function handleBlocked({ shooterId, origin, direction }) {
        if (!origin || !direction) return;
        if (shooterId !== gameState.playerId) {
            const from = new THREE.Vector3(origin.x, origin.y, origin.z);
            const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
            createVisual(from, dir, true);
        }
    }

    function handleHit({ shooterId, targetId, position, origin, direction, health, damage }) {
        if (!origin || !direction) return;
        const from = new THREE.Vector3(origin.x, origin.y, origin.z);
        const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();

        if (shooterId !== gameState.playerId) {
            createVisual(from, dir, false);
        }

        EventBus.emit("player:healthChanged", { playerId: targetId, health });
        EventBus.emit("player:tookDamage", { position, health, damage });
    }

    function createVisual(origin, direction, showImpact = true, targetPoint = null) {
        effectSystem.spawnMuzzleFlash(origin, direction);
        effectSystem.spawnTracer(origin, direction);

        if (showImpact && targetPoint) {
            effectSystem.spawnHitEffect(targetPoint, direction.clone().negate());
        }
    }

    return {
        shoot,
        handleBlocked,
        handleHit
    };
}
