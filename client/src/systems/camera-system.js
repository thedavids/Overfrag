import * as THREE from 'three';
import { EventBus, GameState } from 'shared';

export function createCameraSystem({ scene, inputSystem }) {
    let firstPerson = false;
    let camera;
    let hudCamera;
    const raycaster = new THREE.Raycaster();

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function initCamera() {
        camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
        camera.position.set(0, 2, 6);
        scene.add(camera);

        hudCamera = new THREE.OrthographicCamera(0, window.innerWidth, window.innerHeight, 0, -10, 10);
    }

    function getCamera() {
        return camera;
    }

    function getHudCamera() {
        return hudCamera;
    }

    function toggleView() {
        firstPerson = !firstPerson;
    }

    function isFirstPerson() {
        return firstPerson;
    }

    function getAimDirection(playerObj) {
        const centerDirection = new THREE.Vector3();
        camera.getWorldDirection(centerDirection);

        const coneTip = playerObj
            ? playerObj.position.clone().add(centerDirection.clone().multiplyScalar(2))
            : null;

        return { centerDirection, coneTip };
    }

    function getCrosshairTarget(octree, maxDistance = 1000) {
        const tempRaycaster = new THREE.Raycaster();
        tempRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        tempRaycaster.far = maxDistance;

        const origin = tempRaycaster.ray.origin.clone();
        const direction = tempRaycaster.ray.direction.clone();

        // World hit (via octree)
        const worldCandidates = octree.queryRay(origin, direction, maxDistance);
        const worldHits = tempRaycaster.intersectObjects(worldCandidates, true);
        const worldHitPoint = worldHits.length > 0 ? worldHits[0].point : null;

        // Player hit (manual box test)
        let hitPlayer = null;
        let hitPlayerPoint = null;
        let nearestPlayerDist = Infinity;

        for (const id in gameState.players) {
            const player = gameState.players[id];
            if (id === gameState.playerId) continue;

            const playerPos = player.position.clone(); // World position of the player
            const bbox = new THREE.Box3().setFromCenterAndSize(
                playerPos.clone().add(new THREE.Vector3(0, 0.5, 0)), // center (chest height)
                new THREE.Vector3(1, 2, 1) // width, height, depth — adjust as needed
            );

            const hit = tempRaycaster.ray.intersectBox(bbox, new THREE.Vector3());
            if (hit) {
                const dist = origin.distanceTo(hit);
                if (dist < nearestPlayerDist) {
                    nearestPlayerDist = dist;
                    hitPlayer = player;
                    hitPlayerPoint = hit.clone();
                }
            }
        }

        // Final decision
        let worldHitPointDist = worldHitPoint != null ? origin.distanceTo(worldHitPoint) : null;
        let finalPoint = origin.clone().add(direction.clone().multiplyScalar(maxDistance));
        if (worldHitPoint && (!hitPlayerPoint || worldHitPointDist < nearestPlayerDist)) {
            finalPoint = worldHitPoint.clone();
        } else if (hitPlayerPoint) {
            finalPoint = hitPlayerPoint.clone();
        }

        return {
            origin,
            direction,
            point: finalPoint,
            hitPlayer
        };
    }

    function update(octree, desiredOffset = new THREE.Vector3(0, 1, 4)) {
        const playerObj = gameState.playerObj;
        if (!playerObj) return;

        const { playerYaw, playerPitch } = inputSystem.getLookAngles();

        const offset = firstPerson
            ? new THREE.Vector3(0, 1.5, 0)
            : desiredOffset.clone().applyEuler(new THREE.Euler(playerPitch, playerYaw, 0, 'YXZ'));

        const cameraRight = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, playerYaw, 0));
        const cameraPos = playerObj.position.clone().add(offset).add(cameraRight.multiplyScalar(1.5));
        const rayOrigin = playerObj.position.clone().add(firstPerson
            ? new THREE.Vector3(0, 1.5, 0)
            : new THREE.Vector3(0, 2.5, 0)
        );
        const cameraDir = cameraPos.clone().sub(rayOrigin).normalize();

        const distance = rayOrigin.distanceTo(cameraPos);
        const candidates = octree.queryRay(rayOrigin, cameraDir, distance);
        raycaster.set(rayOrigin, cameraDir);
        raycaster.far = distance;
        const hits = raycaster.intersectObjects(candidates, true);

        const finalPos = hits.length > 0
            ? hits[0].point.clone().add(cameraDir.clone().multiplyScalar(-0.1))
            : cameraPos;

        camera.position.copy(finalPos);

        const lookTarget = camera.position.clone().add(
            new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(playerPitch, playerYaw, 0, 'YXZ')).multiplyScalar(10)
        );

        camera.lookAt(lookTarget);

        playerObj.visible = !firstPerson;
    }

    EventBus.on("input:toggleView", () => {
        toggleView();
    });

    return {
        initCamera,
        getCamera,
        getHudCamera,
        toggleView,
        isFirstPerson,
        getAimDirection,
        getCrosshairTarget,
        update
    };
}
