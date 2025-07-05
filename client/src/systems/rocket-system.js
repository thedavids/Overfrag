import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createRocketSystem({ scene, cameraSystem, effectSystem, socket }) {
    const COOLDOWN = 1000; // ms between rockets
    let lastFired = 0;

    const rockets = [];
    const rocketMaterial = new THREE.MeshBasicMaterial({ color: 0xff9900 });
    let localRocketIdCounter = 0;
    const pendingRockets = {};

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

        let muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0))
            .add(forward.clone().multiplyScalar(1.5));

        let shootDir = targetPoint.clone().sub(muzzle).normalize();
        const distance = shootDir.length();
        const minDistance = 1.0;

        if (distance < minDistance) {
            shootDir = forward.clone();
            muzzle = gameState.playerObj.position.clone()
                .add(new THREE.Vector3(0, 0.5, 0))
                .add(forward.clone());
        } else {
            shootDir.normalize();
        }

        const rocketId = `rocket-${gameState.playerId}-${Date.now()}-${localRocketIdCounter++}`;
        const rocketObj = createRocketVisual(muzzle.clone(), shootDir.clone(), rocketId);

        pendingRockets[rocketId] = { object: rocketObj };

        EventBus.emit("player:launchRocket", {
            roomId: gameState.roomId,
            origin: muzzle,
            direction: shootDir,
            rocketId
        });
    }

    function createRocketVisual(origin, direction, rocketId) {
        const length = 1.2;
        const geometry = new THREE.CylinderGeometry(0.1, 0.1, length, 8);
        const rocket = new THREE.Mesh(geometry, rocketMaterial);

        rocket.rotation.x = Math.PI / 2;
        rocket.position.copy(origin.clone().add(direction.clone().multiplyScalar(length / 2)));
        rocket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        rocket.userData.id = rocketId;

        scene.add(rocket);

        rockets.push({
            mesh: rocket,
            direction: direction.clone().normalize(),
            speed: 30,
            life: 5
        });

        return rocket;
    }

    function createExplosion(position) {
        effectSystem.createRocketExplosion(position);
    }

    function update(delta) {
        for (let i = rockets.length - 1; i >= 0; i--) {
            const rocket = rockets[i];
            rocket.mesh.position.addScaledVector(rocket.direction, delta * rocket.speed);
            rocket.life -= delta;
            if (rocket.life <= 0) {
                scene.remove(rocket.mesh);
                rockets.splice(i, 1);
            }
        }
    }

    function handleLaunched({ shooterId, origin, direction, id }) {
        const from = new THREE.Vector3(origin.x, origin.y, origin.z);
        const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();

        if (shooterId === gameState.playerId && pendingRockets[id]) {
            const { object } = pendingRockets[id];
            object.position.copy(from);
            object.userData.direction = dir;
            delete pendingRockets[id];
        } else {
            createRocketVisual(from, dir, id);
        }
    }

    function handleExploded({ id, position }) {
        const index = rockets.findIndex(r => r.mesh.userData.id === id);
        if (index !== -1) {
            scene.remove(rockets[index].mesh);
            rockets.splice(index, 1);
        }

        if (position) {
            createExplosion(new THREE.Vector3(position.x, position.y, position.z));
        }
    }

    function handleHit({ shooterId, targetId, position, damage, health }) {
        EventBus.emit("player:rocketExplosion", { playerId: targetId, position });
        if (shooterId !== targetId) {
            EventBus.emit("player:healthChanged", { playerId: targetId, health });
            EventBus.emit("player:tookDamage", { position, health, damage });
        }
    }

    return {
        shoot,
        update,
        handleLaunched,
        handleExploded,
        handleHit
    };
}
