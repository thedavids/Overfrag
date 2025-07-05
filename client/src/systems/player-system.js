import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createPlayerSystem({ inputSystem, grappleSystem, PLAYER_CAPSULE_RADIUS, PLAYER_CAPSULE_HEIGHT }) {
    const GRAVITY = -20.8;
    const GRAVITY_TERMINAL_VELOCITY = -150;
    const JUMP_SPEED = 12;
    const MOVE_SPEED = 7;
    const PLAYER_HEIGHT = 1.0;
    const GROUND_RAY_OFFSET = 0.09;
    const PLAYER_HALF_HEIGHT = PLAYER_HEIGHT / 2.0;
    const DEBUG_ARROW_SCALE = 2.0;
    const GROUND_SLOPE_THRESHOLD = 0.7;

    let localId = null;
    let localName = '';
    let localHealth = 0;
    let isGrounded = false;

    const velocity = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const vecForward = new THREE.Vector3();
    const vecRight = new THREE.Vector3();
    const vecMoveDir = new THREE.Vector3();
    const vecRayOrigin = new THREE.Vector3();
    const vecGroundOffset = new THREE.Vector3(0, GROUND_RAY_OFFSET, 0);
    const rayDown = new THREE.Vector3(0, -1, 0);

    const _capsuleStart = new THREE.Vector3();
    const _capsuleEnd = new THREE.Vector3();

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function setLocalPlayer(id, name, health) {
        localId = id;
        localName = name;
        localHealth = health;
    }

    function getLocalPlayerId() {
        return localId;
    }

    function getLocalName() {
        return localName;
    }

    function getLocalHealth() {
        return localHealth;
    }

    function setLocalHealth(health) {
        localHealth = health;
    }

    function getVelocity() {
        return velocity;
    }

    function getPlayerCapsule(player) {
        const radius = player.userData.capsule?.radius || PLAYER_CAPSULE_RADIUS;
        const height = player.userData.capsule?.height || PLAYER_CAPSULE_HEIGHT;

        _capsuleStart.set(player.position.x, player.position.y - height / 2 + radius, player.position.z);
        _capsuleEnd.set(player.position.x, player.position.y + height / 2 - radius, player.position.z);

        return {
            start: _capsuleStart,
            end: _capsuleEnd,
            radius,
            height,
        };
    }

    function update(delta, octree) {
        const player = gameState.playerObj;
        if (!player) return;

        const speed = velocity.length();
        const moveDistance = speed * delta;
        const maxStepDistance = gameState.requiresPrecisePhysics ? 0.02 : 0.1;
        const steps = Math.ceil(moveDistance / maxStepDistance);
        const clampedSteps = Math.min(Math.max(steps, 1), 50);
        const subDelta = delta / clampedSteps;

        for (let i = 0; i < clampedSteps; i++) {
            updatePhysicsStep(subDelta, octree);
        }
    }

    function updatePhysicsStep(delta, octree) {
        const player = gameState.playerObj;
        if (!player) return;

        const keyState = inputSystem.getKeyState();
        const { playerYaw } = inputSystem.getLookAngles();
        player.rotation.y = playerYaw;

        applyGravity(delta);
        handleJump();

        let moveDir = computeMovementDirection(player.rotation, keyState);
        grappleSystem.updatePhysic(delta, player, velocity, moveDir, MOVE_SPEED, isGrounded);
        performIntegratedMovement(player, delta, octree);
        checkGroundCollision(octree, player);

        const isIdle =
            isGrounded &&
            moveDir.lengthSq() === 0 &&
            Math.abs(velocity.x) < 0.1 &&
            Math.abs(velocity.z) < 0.1;

        emitMovementEvents(player, isIdle);
    }

    function applyGravity(delta) {
        if (!grappleSystem.state.attached && !isGrounded) {
            velocity.y += GRAVITY * delta;
            velocity.y = Math.max(velocity.y, GRAVITY_TERMINAL_VELOCITY);
        }
    }

    function handleJump() {
        if (isGrounded && inputSystem.isJumpBuffered()) {
            velocity.y = JUMP_SPEED;
            isGrounded = false;
            inputSystem.clearJumpBuffer();
        } else if (!inputSystem.isJumpBuffered()) {
            inputSystem.clearJumpBuffer();
        }
    }

    function computeMovementDirection(rotation, keyState) {
        vecForward.set(0, 0, -1).applyEuler(rotation);
        vecRight.set(1, 0, 0).applyEuler(rotation);
        vecMoveDir.set(0, 0, 0);

        if (keyState['w']) vecMoveDir.add(vecForward);
        if (keyState['s']) vecMoveDir.sub(vecForward);
        if (keyState['a']) vecMoveDir.sub(vecRight);
        if (keyState['d']) vecMoveDir.add(vecRight);
        if (vecMoveDir.lengthSq() > 0) vecMoveDir.normalize();

        return vecMoveDir;
    }
    // Preallocated vectors
    const _intendedMovement = new THREE.Vector3();
    const _stepMovement = new THREE.Vector3();
    const _stepStartPos = new THREE.Vector3();
    const _horizontalVelocity = new THREE.Vector3();
    const _collisionNormal = new THREE.Vector3();
    const _remainingMovement = new THREE.Vector3();
    const _tempHorizontal = new THREE.Vector3();
    const _pushResult = new THREE.Vector3();

    function performIntegratedMovement(me, delta, octree) {

        _intendedMovement.copy(velocity).multiplyScalar(delta);
        const movementMagnitude = _intendedMovement.length();

        if (movementMagnitude < 0.001) return;

        if (movementMagnitude < 0.01) {
            me.position.add(_intendedMovement);

            const capsule = getPlayerCapsule(me);
            const nearby = octree.queryCapsule(capsule);

            if (nearby.length > 0) {
                const pushResult = resolveCapsulePenetration(capsule, nearby);
                if (pushResult) {
                    me.position.add(pushResult);
                }
            }
            return;
        }

        const maxStepSize = 0.1;
        const steps = Math.max(1, Math.ceil(movementMagnitude / maxStepSize));
        _stepMovement.copy(_intendedMovement).divideScalar(steps);

        for (let step = 0; step < steps; step++) {

            _stepStartPos.copy(me.position);
            _horizontalVelocity.set(velocity.x, 0, velocity.z);
            me.position.add(_stepMovement);

            const capsule = getPlayerCapsule(me);
            const nearby = octree.queryCapsule(capsule);

            if (nearby.length > 0) {
                const push = resolveCapsulePenetration(capsule, nearby);

                if (push && push.length() > 0.001) {

                    _pushResult.copy(push);
                    me.position.add(_pushResult);

                    _collisionNormal.copy(_pushResult).normalize();
                    const remainingSteps = steps - step - 1;

                    if (remainingSteps > 0) {
                        _remainingMovement.copy(_stepMovement).multiplyScalar(remainingSteps);
                        _remainingMovement.projectOnPlane(_collisionNormal);
                        me.position.add(_remainingMovement);
                    }

                    const isGentleSlope = _collisionNormal.y > GROUND_SLOPE_THRESHOLD;

                    if (isGentleSlope) {
                        velocity.x = _horizontalVelocity.x;
                        velocity.z = _horizontalVelocity.z;
                    } else {
                        _tempHorizontal.set(_horizontalVelocity.x, 0, _horizontalVelocity.z);
                        _tempHorizontal.projectOnPlane(_collisionNormal);
                        velocity.x = _tempHorizontal.x;
                        velocity.z = _tempHorizontal.z;
                    }

                    if (isGentleSlope) {
                        isGrounded = true;
                        velocity.y = Math.max(0, velocity.y);
                    }

                    if (_collisionNormal.y < -0.5) {

                        // Ceiling detected
                        velocity.y = Math.min(velocity.y, 0); // Stop upward motion
                        if (grappleSystem?.state?.grappleMomentum) {
                            grappleSystem.state.grappleMomentum.y = 0;
                        }
                    }
                    break;
                }
            }

            // only measure when applicable
            if (step === 0 && movementMagnitude > 0.05) {
                const collided = performSweptCapsuleCheck(_stepStartPos, me.position, capsule.radius, octree);

                if (collided) {
                    me.position.copy(_stepStartPos);
                    velocity.multiplyScalar(0.5);
                    break;
                }
            }
        }
    }

    const _SweptMin = new THREE.Vector3();
    const _SweptMax = new THREE.Vector3();
    const _SweptSamplePos = new THREE.Vector3();
    const _TempCapsuleStart = new THREE.Vector3();
    const _TempCapsuleEnd = new THREE.Vector3();

    function performSweptCapsuleCheck(startPos, endPos, capsuleRadius, octree) {
        const movement = endPos.clone().sub(startPos);
        const movementLength = movement.length();

        if (movementLength < 0.001) return false;

        // === 1. Compute bounding box using preallocated vectors ===
        _SweptMin.set(
            Math.min(startPos.x, endPos.x),
            Math.min(startPos.y, endPos.y),
            Math.min(startPos.z, endPos.z)
        ).addScalar(-capsuleRadius);

        _SweptMax.set(
            Math.max(startPos.x, endPos.x),
            Math.max(startPos.y, endPos.y),
            Math.max(startPos.z, endPos.z)
        ).addScalar(capsuleRadius);

        const sweepAABB = { min: _SweptMin, max: _SweptMax };

        // === 2. Query once ===
        const nearby = octree.queryRange(sweepAABB);

        // === 3. Sample along path ===
        const samples = Math.min(5, Math.max(3, Math.ceil(movementLength / 0.1)));

        for (let i = 1; i <= samples; i++) {

            const t = i / samples;
            _SweptSamplePos.copy(startPos).lerp(endPos, t);

            _TempCapsuleStart.copy(_SweptSamplePos).addScalar(0).y += -0.5 + capsuleRadius;
            _TempCapsuleEnd.copy(_SweptSamplePos).addScalar(0).y += 0.5 - capsuleRadius;

            const tempCapsule = {
                start: _TempCapsuleStart,
                end: _TempCapsuleEnd,
                radius: capsuleRadius
            };

            for (const obj of nearby) {
                const penetration = resolveCapsulePenetration(tempCapsule, [obj]);

                if (penetration && penetration.length() > 0.01) {
                    return true;
                }
            }
        }

        return false;
    }

    const _capsuleLine = new THREE.Line3();
    const _closestPointBox = new THREE.Vector3();
    const _closestPointLine = new THREE.Vector3();

    function resolveCapsulePenetration(capsule, objects) {
        const allPushVectors = [];

        for (const obj of objects) {
            const geometry = obj.geometry;
            const bvh = geometry?.boundsTree;
            if (!bvh) continue;

            if (!obj._cachedInvMatrix || !obj._cachedNormalMatrix || obj._matrixWorldNeedsUpdate) {
                obj._cachedInvMatrix = obj.matrixWorld.clone().invert();
                obj._cachedNormalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
            }

            const localCapsule = {
                start: capsule.start.clone().applyMatrix4(obj._cachedInvMatrix),
                end: capsule.end.clone().applyMatrix4(obj._cachedInvMatrix),
                radius: capsule.radius
            };

            bvh.shapecast({
                intersectsBounds: (box) => {
                    _capsuleLine.start.copy(localCapsule.start);
                    _capsuleLine.end.copy(localCapsule.end);
                    box.clampPoint(_capsuleLine.start, _closestPointBox);
                    _capsuleLine.closestPointToPoint(_closestPointBox, true, _closestPointLine);
                    return _closestPointLine.distanceToSquared(_closestPointBox) <= localCapsule.radius ** 2;
                },

                intersectsTriangle: (tri) => {
                    const result = capsuleIntersectsTriangle(localCapsule, tri);
                    if (result?.pushOut && result.pushOut.lengthSq() > 1e-6) {
                        const worldPush = result.pushOut.clone().applyMatrix3(obj._cachedNormalMatrix);
                        allPushVectors.push(worldPush);
                    }
                }
            });
        }

        if (allPushVectors.length === 0) {
            return new THREE.Vector3();
        }

        // Combine push vectors intelligently
        let totalPush = new THREE.Vector3();

        // Sort by magnitude - prioritize larger pushes
        allPushVectors.sort((a, b) => b.lengthSq() - a.lengthSq());

        // Use the strongest push as primary, blend in others
        totalPush.copy(allPushVectors[0]);

        for (let i = 1; i < allPushVectors.length; i++) {
            const weight = Math.min(0.5, allPushVectors[i].length() / allPushVectors[0].length());
            totalPush.add(allPushVectors[i].clone().multiplyScalar(weight));
        }

        // Cap the push to prevent explosive behavior
        const maxPush = 0.5;
        if (totalPush.length() > maxPush) {
            totalPush.setLength(maxPush);
        }

        return totalPush;
    }

    // Scratch vectors (defined once, reused across calls)
    const _closestTriPointStart = new THREE.Vector3();
    const _closestTriPointEnd = new THREE.Vector3();
    const _closestTriPoint = new THREE.Vector3();
    const _closestOnSegment = new THREE.Vector3();
    const _distVec = new THREE.Vector3();

    function capsuleIntersectsTriangle(capsule, triangle) {
        _capsuleLine.start.copy(capsule.start);
        _capsuleLine.end.copy(capsule.end);

        triangle.closestPointToPoint(capsule.start, _closestTriPointStart);
        triangle.closestPointToPoint(capsule.end, _closestTriPointEnd);

        const dStart = capsule.start.distanceToSquared(_closestTriPointStart);
        const dEnd = capsule.end.distanceToSquared(_closestTriPointEnd);

        if (dStart < dEnd) {
            _closestTriPoint.copy(_closestTriPointStart);
        } else {
            _closestTriPoint.copy(_closestTriPointEnd);
        }

        _capsuleLine.closestPointToPoint(_closestTriPoint, true, _closestOnSegment);
        _distVec.copy(_closestOnSegment).sub(_closestTriPoint);

        const distSq = _distVec.lengthSq();

        if (distSq < capsule.radius * capsule.radius) {
            const depth = capsule.radius - Math.sqrt(distSq);
            const pushOut = _distVec.normalize().multiplyScalar(depth);
            return { pushOut };
        }

        return null;
    }

    function checkGroundCollision(octree, me) {
        vecRayOrigin.copy(me.position).add(vecGroundOffset);

        if (window.debug === true) {
            scene.add(new THREE.ArrowHelper(rayDown, vecRayOrigin, 0.6 * DEBUG_ARROW_SCALE, 0x0000ff));
        }

        const rayDistance = 0.5 + PLAYER_HEIGHT + (PLAYER_HEIGHT / 5.0);
        const downCandidates = octree.queryRay(vecRayOrigin, rayDown, rayDistance);
        raycaster.set(vecRayOrigin, rayDown);
        raycaster.far = rayDistance;

        let closestHit = null;

        for (const obj of downCandidates) {
            if (!obj.geometry?.boundsTree) continue;

            const hits = raycaster.intersectObject(obj, true);
            if (hits.length > 0 && (!closestHit || hits[0].distance < closestHit.distance)) {
                closestHit = hits[0];
            }
        }

        if (closestHit) {
            const distanceToGround = closestHit.distance;
            const isMovingDown = velocity.y <= 0.1;

            if (isMovingDown && distanceToGround < rayDistance) {
                isGrounded = true;

                // Snap to ground if very close and slow
                if (distanceToGround < rayDistance && velocity.length() < 1.0) {
                    const targetY = closestHit.point.y + PLAYER_HALF_HEIGHT;
                    me.position.y = targetY;
                    velocity.y = 0;
                }
            }
            else {
                isGrounded = false;
            }
        }
        else {
            isGrounded = false;
        }
    }

    function emitMovementEvents(player, isIdle) {
        EventBus.emit("player:moved", {
            roomId: gameState.roomId,
            position: player.position,
            yaw: player.rotation.y,
            playerId: gameState.playerId,
            isGrounded,
            isIdle
        });

        EventBus.emit("player:animated", {
            playerId: gameState.playerId,
            isGrounded,
            isIdle
        });
    }

    EventBus.on("player:respawned", ({ playerId, health }) => {
        if (playerId === gameState.playerId) {
            velocity.set(0, 0, 0);
            EventBus.emit("player:healthChanged", { playerId, health });
        }
    });

    EventBus.on("player:healthChanged", ({ playerId, health }) => {
        if (playerId === gameState.playerId) {
            setLocalHealth(health);
        }
    });

    EventBus.on("player:rocketExplosion", ({ playerId, position }) => {
        if (playerId !== gameState.playerId) return;

        const playerPos = gameState.playerObj.position;
        const explosionPos = new THREE.Vector3(position.x, position.y, position.z);
        const knockbackDir = playerPos.clone().sub(explosionPos).normalize();

        const distance = playerPos.distanceTo(explosionPos);
        const maxDistance = 6;
        if (distance > maxDistance) return;

        const factor = 1 - distance / maxDistance;
        const strength = 15 * factor;

        velocity.x += knockbackDir.x * strength;
        velocity.y += knockbackDir.y * strength + 2;
        velocity.z += knockbackDir.z * strength;
    });

    return {
        update,
        getVelocity,
        setLocalPlayer,
        getLocalPlayerId,
        getLocalName,
        getLocalHealth,
        setLocalHealth
    };
}
