import * as THREE from 'three';
import { EventBus, GameState } from 'shared';
// import { OctreeDrawQueriedObjects, OctreeClearDebugWires } from './debug-utils.js';

export function createGrappleSystem({ scene, cameraSystem, inputSystem }) {
    const MAX_GRAPPLE_DISTANCE = 1000;
    const MAX_GRAPPLE_LAUNCH_SPEED = 75;
    const GRAPPLE_PULL_STRENGTH = 60;

    const ropeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const remoteGrapples = {};
    const raycaster = new THREE.Raycaster();

    const state = {
        active: false,
        fired: false,
        attached: false,
        point: null,
        origin: null,
        direction: new THREE.Vector3(),
        currentLength: 0,
        isHanging: false,
        mesh: null,
        wasGrappleAttachedLastFrame: false,
        grappleMomentumActive: false,
        grappleMomentum: new THREE.Vector3(),
        previousGrapplePosition: new THREE.Vector3()
    };

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    EventBus.on("input:fireGrapple", () => fire());
    EventBus.on("input:releaseGrapple", () => release());

    function fire() {
        if (!gameState.roomId || !gameState.playerObj || state.fired) return;

        const { centerDirection, coneTip } = cameraSystem.getAimDirection(gameState.playerObj);
        const { point: targetPoint } = cameraSystem.getCrosshairTarget(gameState.octree, 1000);
        const shootDir = targetPoint.clone().sub(coneTip).normalize();

        Object.assign(state, {
            fired: true,
            active: true,
            attached: false,
            currentLength: 0,
            direction: shootDir,
            origin: coneTip.clone(),
            point: null
        });

        EventBus.emit("player:grappleStarted", {
            roomId: gameState.roomId,
            origin: coneTip,
            direction: centerDirection
        });
    }

    function release() {
        if (!state.active) return;

        Object.assign(state, {
            active: false,
            fired: false,
            attached: false,
            point: null,
            origin: null
        });

        if (state.mesh) {
            scene.remove(state.mesh);
            state.mesh.geometry.dispose();
            state.mesh.material.dispose();
            state.mesh = null;
        }

        EventBus.emit("player:grappleEnded", { roomId: gameState.roomId });
    }

    function updatePhysic(delta, player, playerVelocity, vecMoveDir, moveSpeed, isGrounded) {
        const nowAttached = state.attached;
        const justReleased = !nowAttached && state.wasGrappleAttachedLastFrame;

        if (nowAttached) {
            state.previousGrapplePosition.copy(player.position);
        }

        if (justReleased) {
            const swingVel = player.position.clone()
                .sub(state.previousGrapplePosition)
                .divideScalar(delta);

            if (swingVel.length() > MAX_GRAPPLE_LAUNCH_SPEED) {
                swingVel.setLength(MAX_GRAPPLE_LAUNCH_SPEED);
            }

            state.grappleMomentum.copy(swingVel);
            state.grappleMomentumActive = true;
            playerVelocity.copy(swingVel);
        }

        if (!nowAttached && state.grappleMomentumActive) {
            let decay = 0.995;
            const input = vecMoveDir.clone().normalize().multiplyScalar(moveSpeed);
            const dot = vecMoveDir.clone().normalize().dot(state.grappleMomentum.clone().normalize());

            if (dot < -0.1) decay = 0.95;

            state.grappleMomentum.multiplyScalar(decay);

            ['x', 'z'].forEach(axis => {
                if (Math.abs(state.grappleMomentum[axis]) < Math.abs(input[axis])) {
                    state.grappleMomentum[axis] = input[axis];
                }
                playerVelocity[axis] = state.grappleMomentum[axis];
            });

            if (state.grappleMomentum.lengthSq() < 0.01) {
                state.grappleMomentumActive = false;
            }
        } else if (!nowAttached && vecMoveDir.lengthSq() > 0) {
            playerVelocity.x = vecMoveDir.x * moveSpeed;
            playerVelocity.z = vecMoveDir.z * moveSpeed;
        } else if (!nowAttached && isGrounded) {
            playerVelocity.x *= 0.8;
            playerVelocity.z *= 0.8;
        }

        if (isGrounded && vecMoveDir.lengthSq() < 0.01) {
            playerVelocity.set(0, playerVelocity.y, 0);
            state.grappleMomentum.set(0, 0, 0);
            state.grappleMomentumActive = false;
        }

        state.wasGrappleAttachedLastFrame = nowAttached;
    }

    function update(delta, velocity, octree) {
        if (!state.active) {
            //OctreeClearDebugWires(scene, 2);
            return;
        }

        const playerObj = gameState.playerObj;
        if (!playerObj) return;

        if (state.fired && !state.attached) {
            state.currentLength = Math.min(state.currentLength + delta * 80, MAX_GRAPPLE_DISTANCE);
            const candidates = octree.queryRay(state.origin, state.direction, state.currentLength);
            raycaster.set(state.origin.clone(), state.direction.clone());
            raycaster.far = state.currentLength;

            //OctreeDrawQueriedObjects(candidates, scene, 2, 0x0000ff);

            const hits = raycaster.intersectObjects(candidates, true);
            if (hits.length > 0) {
                state.point = hits[0].point.clone();
                state.attached = true;
            }
        }

        if (state.attached && state.point) {
            const toPoint = state.point.clone().sub(playerObj.position);
            const distance = toPoint.length();

            if (distance > 1) {
                velocity.addScaledVector(toPoint.normalize(), delta * GRAPPLE_PULL_STRENGTH);
                state.isHanging = false;
            } else {
                if (inputSystem.isJumpBuffered() && velocity.y <= 0) {
                    // Let jump logic handle
                } else {
                    velocity.set(0, 0, 0);
                }
                state.isHanging = true;
            }
        }

        updateRopeVisual(playerObj);
    }

    function getCurrentTipPosition() {
        return state.attached && state.point
            ? state.point.clone()
            : state.origin.clone().addScaledVector(state.direction, state.currentLength);
    }

    function updateRopeVisual(playerObj) {
        if (!state.active || !state.origin) {
            if (state.mesh) {
                scene.remove(state.mesh);
                state.mesh.geometry.dispose();
                state.mesh.material.dispose();
                state.mesh = null;
            }
            return;
        }

        const start = playerObj.position.clone().add(new THREE.Vector3(0, 0.5, 0));
        const end = getCurrentTipPosition();
        state.mesh = createOrUpdateRopeCylinder(state.mesh, start, end, ropeMaterial);
    }

    function createOrUpdateRopeCylinder(mesh, start, end, material) {
        const dir = new THREE.Vector3().subVectors(end, start);
        const length = dir.length();
        const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

        if (mesh) {
            scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }

        const geometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8, 1, true);
        mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(midpoint);
        mesh.lookAt(end);
        mesh.rotateX(Math.PI / 2);

        scene.add(mesh);
        return mesh;
    }

    function remoteGrappleStart({ playerId, origin, direction, playerObj }) {
        remoteGrapples[playerId] = {
            mesh: null,
            origin: new THREE.Vector3(origin.x, origin.y, origin.z),
            direction: new THREE.Vector3(direction.x, direction.y, direction.z),
            distance: 0,
            playerObj
        };
    }

    function remoteGrappleEnd({ playerId }) {
        const g = remoteGrapples[playerId];
        if (g) {
            if (g.mesh) {
                scene.remove(g.mesh);
                g.mesh.geometry.dispose();
                g.mesh.material.dispose();
            }
            delete remoteGrapples[playerId];
        }
    }

    function updateRemoteGrapples(delta) {
        for (const g of Object.values(remoteGrapples)) {
            if (!g.playerObj) continue;
            g.distance += delta * 80;
            const tip = g.origin.clone().addScaledVector(g.direction, g.distance);
            const start = g.playerObj.position.clone().add(new THREE.Vector3(0, 0.5, 0));
            const material = new THREE.MeshBasicMaterial({ color: 0x00ffff });

            g.mesh = createOrUpdateRopeCylinder(g.mesh, start, tip, material);
        }
    }

    return {
        fire,
        updatePhysic,
        release,
        update,
        state,
        remoteGrappleStart,
        remoteGrappleEnd,
        updateRemoteGrapples
    };
}
