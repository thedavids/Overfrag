import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createLaserSystem({ scene, cameraSystem }) {
    const COOLDOWN = 250;
    let lastFired = 0;

    const lasers = [];
    const laserMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    let localLaserIdCounter = 0;
    const pendingLasers = {};

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function shoot() {
        if (!gameState.roomId || !gameState.playerObj) return;

        const now = Date.now();
        if (now - lastFired < COOLDOWN) return;
        lastFired = now;

        const { point: targetPoint } = cameraSystem.getCrosshairTarget(gameState.octree, 500);

        const forward = new THREE.Vector3();
        cameraSystem.getCamera().getWorldDirection(forward);

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

        const laserId = `laser-${gameState.playerId}-${Date.now()}-${localLaserIdCounter++}`;
        const laserObj = createLaserVisual(muzzle.clone(), shootDir.clone(), laserId);

        pendingLasers[laserId] = { object: laserObj, origin: muzzle, direction: shootDir };

        EventBus.emit("player:shot", {
            roomId: gameState.roomId,
            origin: muzzle,
            direction: shootDir,
            laserId
        });
    }

    function createLaserVisual(origin, direction, laserId) {
        const length = 5;
        const geometry = new THREE.CylinderGeometry(0.05, 0.05, length, 8);
        const laser = new THREE.Mesh(geometry, laserMaterial);

        laser.rotation.x = Math.PI / 2;
        laser.position.copy(origin.clone().add(direction.clone().multiplyScalar(length / 2)));
        laser.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        laser.userData.id = laserId;

        scene.add(laser);

        lasers.push({
            mesh: laser,
            direction: direction.clone().normalize(),
            speed: 100,
            life: 2
        });

        return laser;
    }

    function update(delta) {
        for (let i = lasers.length - 1; i >= 0; i--) {
            const laser = lasers[i];
            laser.mesh.position.addScaledVector(laser.direction, delta * laser.speed);
            laser.life -= delta;
            if (laser.life <= 0) {
                scene.remove(laser.mesh);
                lasers.splice(i, 1);
            }
        }
    }

    function handleFired({ shooterId, origin, direction, id }) {
        if (!origin || !direction) return;
        const from = new THREE.Vector3(origin.x, origin.y, origin.z);
        const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();

        if (shooterId === gameState.playerId && pendingLasers[id]) {
            const { object } = pendingLasers[id];
            object.position.copy(from);
            object.userData.direction = dir;
            delete pendingLasers[id];
        } else {
            createLaserVisual(from, dir, id);
        }
    }

    function handleBlocked({ id }) {
        const index = lasers.findIndex(l => l.mesh.userData.id === id);
        if (index !== -1) {
            scene.remove(lasers[index].mesh);
            lasers.splice(index, 1);
        }
    }

    return {
        shoot,
        update,
        handleFired,
        handleBlocked
    };
}
