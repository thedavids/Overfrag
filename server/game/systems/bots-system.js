import { EventBus } from '../shared/event-bus.js';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export function createBotsSystem({ laserSystem, shotgunSystem, machinegunSystem, rocketSystem, health }) {
    const bots = {};
    const botRadius = 0.5;
    const botHeight = 1.6;
    let localProjectileCounter = 0;
    const sharedRaycaster = new THREE.Raycaster();

    const nameOptions = [
        ["Chris Terreri", "laser"],
        ["Glenn Healy", "shotgun"],
        ["Andy Moog", "machinegun"],
        ["Mike Vernon", "rocket"],
        ["Tom Barasso", "laser"],
        ["Curtis Joseph", "shotgun"],
        ["Kelly Hrudey", "machinegun"],
        ["Darren Puppa", "rocket"],
        ["Don Beaupre", "laser"],
        ["Mike Richter", "shotgun"],
        ["John Vanbiesbrouck", "machinegun"]
    ];

    const modelOptions = ["Soldier1.glb", "Soldier2.glb"];

    function spawnBot(id, room, name = null, modelName = null) {

        const botItem = nameOptions[Math.floor(Math.random() * nameOptions.length)];
        name = name || botItem[0];
        modelName = modelName || modelOptions[Math.floor(Math.random() * modelOptions.length)];
        const weapon = botItem[1];

        const bounds = getXZBoundsFromBVH(room.map?.bvhMesh);

        const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
        const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
        let y = getYforXZ(room.map?.bvhMesh, x, z);
        const position = new THREE.Vector3(x, y, z);

        bots[id] = {
            id,
            name,
            position,
            rotation: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            target: null,
            isDead: false,
            room: room,
            isGrounded: false,
            fallVelocity: 0,
            lastPosition: position.clone(),
            stuckTimer: 0,
            jumping: false,
            jumpCooldown: 0,
            shotCooldown: 0,
            weapon: weapon,
            strafeAngle: Math.random() * Math.PI * 2,
            strafeDirection: Math.random() < 0.5 ? 1 : -1, // 1 = clockwise, -1 = counterclockwise,
            positionHistory: [], // Track last few positions
            unstuckAttempts: 0,
            lastUnstuckTime: 0,
            emergencyTeleportCooldown: 0,
            isStuckInGeometry: false,
            consecutiveStuckFrames: 0,
        };

        room.players[id] = {
            name,
            position,
            modelName,
            health: health,
            kill: 0,
            death: 0,
            kdratio: 0,
            isBot: true
        };

        return bots[id];
    }

    EventBus.on("roomsSystem:roomDeleted", ({ roomId }) => {
        // Remove all bots in the deleted room
        for (const botId in bots) {
            if (bots[botId].room.id === roomId) {
                delete bots[botId];
            }
        }
    });

    EventBus.on("player:respawned", ({ playerId, position, room }) => {
        const bounds = getXZBoundsFromBVH(room.map?.bvhMesh);

        const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
        const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
        let y = getYforXZ(room.map?.bvhMesh, x, z);

        if (bots[playerId] != null) {
            bots[playerId].position = new THREE.Vector3(x, y, z);
        }
        if (room.players[playerId] != null) {
            room.players[playerId].position = new THREE.Vector3(x, y, z);
        }
    });

    function getXZBoundsFromBVH(bvhMesh, marginPercent = 0.2) {
        if (!bvhMesh) return { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

        // Create a proper mesh with the BVH geometry
        let tempMesh = bvhMesh;

        if (!tempMesh.geometry.boundingBox) {
            tempMesh.geometry.computeBoundingBox();
        }

        const bbox = tempMesh.geometry.boundingBox;

        const xSize = bbox.max.x - bbox.min.x;
        const zSize = bbox.max.z - bbox.min.z;

        const xMargin = xSize * marginPercent;
        const zMargin = zSize * marginPercent;

        return {
            minX: bbox.min.x + xMargin,
            maxX: bbox.max.x - xMargin,
            minZ: bbox.min.z + zMargin,
            maxZ: bbox.max.z - zMargin
        };
    }

    function getMapCenter(bvhMesh) {
        const bounds = getXZBoundsFromBVH(bvhMesh);
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        const centerY = getYforXZ(bvhMesh, centerX, centerZ);
        return new THREE.Vector3(centerX, centerY, centerZ);
    }

    function getYforXZ(bvhMesh, x, z) {
        let y = 200; // fallback spawn height

        if (bvhMesh) {
            // Ensure tempMesh has proper geometry and material
            let tempMesh = bvhMesh;
            if (!tempMesh.material) {
                tempMesh.material = new THREE.MeshBasicMaterial();
            }

            const rayOrigin = new THREE.Vector3(x, 1000, z);
            const raycaster = new THREE.Raycaster(rayOrigin, new THREE.Vector3(0, -1, 0), 0, 2000);
            const hits = raycaster.intersectObject(tempMesh, true);

            if (hits.length > 0) {
                y = hits[0].point.y + botHeight / 2; // Position bot center at ground + half height
            }
        }
        return y;
    }

    const _moveDir = new THREE.Vector3();
    const _desiredMovement = new THREE.Vector3();
    const _lookDir = new THREE.Vector3();
    const _movementDelta = new THREE.Vector3();
    const _horizontalMove = new THREE.Vector3();
    const _testPos = new THREE.Vector3();
    const _testPosX = new THREE.Vector3();
    const _testPosZ = new THREE.Vector3();
    const _verticalMove = new THREE.Vector3();
    const _groundCheckPos = new THREE.Vector3();
    const _losFrom = new THREE.Vector3();
    const _losTo = new THREE.Vector3();
    const _losDir = new THREE.Vector3();
    const _intersectsBelowOrigin = new THREE.Vector3();
    const _intersectsBelowDir = new THREE.Vector3(0, -1, 0);
    const _shootDir = new THREE.Vector3();
    const _randomAxis = new THREE.Vector3();
    const _quaternion = new THREE.Quaternion();
    const _capsuleTestPos = new THREE.Vector3();
    const _xOffset = new THREE.Vector3();
    const _zOffset = new THREE.Vector3();
    const _vOffset = new THREE.Vector3();
    const _capsuleStart = new THREE.Vector3();
    const _capsuleEnd = new THREE.Vector3();
    const _capsuleBox = new THREE.Box3();
    const _triSegment = new THREE.Line3();
    const _triClosestPoint = new THREE.Vector3();
    const _triTmpVec = new THREE.Vector3();

    const _targetPos = new THREE.Vector3();
    const _strafeOffset = new THREE.Vector3();
    const _clonedTarget = new THREE.Vector3();

    function update(deltaMs) {
        const delta = deltaMs / 1000;

        for (const botId in bots) {
            const bot = bots[botId];
            if (bot.isDead) continue;

            const bvhMesh = bot.room.map?.bvhMesh;
            if (!bvhMesh) continue;

            // Cooldowns
            bot.jumpCooldown = Math.max(bot.jumpCooldown - delta, 0);
            bot.shotCooldown = Math.max(bot.shotCooldown - delta, 0);
            if (bot.emergencyTeleportCooldown > 0) {
                bot.emergencyTeleportCooldown -= delta;
            }

            // Geometry recovery
            const unstuckPos = handleStuckBot(bot, delta, bvhMesh);
            if (unstuckPos) {
                bot.position.copy(unstuckPos);
                bot.room.players[botId].position.copy(unstuckPos);
                bot.lastPosition.copy(unstuckPos);
                continue;
            }

            const players = Object.entries(bot.room.players).filter(([id]) => id !== botId);
            if (players.length === 0) continue;

            // === Find nearest player ===
            let closestPlayer = null;
            let minDistSq = Infinity;
            for (const [, player] of players) {
                const distSq = bot.position.distanceToSquared(player.position);
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    closestPlayer = player;
                }
            }

            const targetPlayer = closestPlayer;
            if (targetPlayer) {
                _clonedTarget.copy(targetPlayer.position);
                _targetPos.copy(_clonedTarget);
            } else {
                _targetPos.copy(getMapCenter(bvhMesh));
            }

            // === Strafing Movement ===
            if (targetPlayer) {
                bot.strafeAngle += bot.strafeDirection * 1.5 * delta;
                _strafeOffset.set(
                    Math.cos(bot.strafeAngle) * 12,
                    0,
                    Math.sin(bot.strafeAngle) * 12
                );
                bot.desiredTargetPosition = _targetPos.clone().add(_strafeOffset);
            } else {
                bot.desiredTargetPosition = _targetPos.clone();
            }

            // === Desired Movement Vector ===
            _moveDir.subVectors(bot.desiredTargetPosition, bot.position);
            const distanceToGoal = _moveDir.length();
            if (distanceToGoal > 0.1) {
                _moveDir.normalize();
                _desiredMovement.copy(_moveDir).multiplyScalar(7 * delta);
            } else {
                _desiredMovement.set(0, 0, 0);
            }

            // === Gravity ===
            const gravity = -30;
            const MAX_FALL_SPEED = -40;
            if (!bot.isGrounded) {
                bot.fallVelocity += gravity * delta;
                bot.fallVelocity = Math.max(bot.fallVelocity, MAX_FALL_SPEED);
            }

            _desiredMovement.y = bot.fallVelocity * delta;

            // === Jumping logic ===
            const movementSinceLast = bot.position.distanceToSquared(bot.lastPosition);
            const isMovingHorizontally = movementSinceLast > 0.01;

            if (
                bot.isGrounded &&
                bot.jumpCooldown <= 0 &&
                (!isMovingHorizontally || Math.random() < 0.01)
            ) {
                bot.fallVelocity = 12;
                _desiredMovement.y = bot.fallVelocity * delta;
                bot.jumping = true;
                bot.isGrounded = false;
                bot.jumpCooldown = 1.5 + Math.random();
            }

            const nextPos = calculateNextPosition(bot, _desiredMovement, bvhMesh, delta);

            // === Ground Check ===
            if (!bot.isGrounded && bot.fallVelocity <= 0) {
                bot.isGrounded = checkGrounded(nextPos, bvhMesh);
            }
            if (bot.isGrounded) {
                bot.fallVelocity = 0;
                bot.jumping = false;
            }

            // === Final movement and state ===
            if (!checkCapsuleCollision(nextPos, bvhMesh, botRadius, botHeight)) {
                bot.position.copy(nextPos);
                bot.room.players[botId].position.copy(nextPos);
            }

            // === Look Rotation ===
            _lookDir.subVectors(_targetPos, bot.position);
            _lookDir.y = 0;
            _lookDir.normalize();
            bot.rotation.set(0, Math.atan2(_lookDir.x, _lookDir.z) + Math.PI, 0);

            // === Shooting ===
            if (targetPlayer && hasLineOfSight(bot.position, _targetPos, bvhMesh)) {
                tryShoot(delta, bot.room, botId, bot.position, _targetPos);
            }

            // === Stuck Detection (disabled during jump) ===
            if (!bot.jumping) {
                _movementDelta.subVectors(bot.position, bot.lastPosition);
                const isStuck = _movementDelta.lengthSq() < 0.005;
                bot.stuckTimer = isStuck ? bot.stuckTimer + delta : 0;
            }

            // === Emit Update ===
            EventBus.emit("botsSystem:moved", {
                botId,
                room: bot.room,
                position: bot.position,
                rotation: bot.rotation,
                isIdle: _desiredMovement.lengthSq() < 0.01,
                isGrounded: bot.isGrounded
            });

            bot.lastPosition.copy(bot.position);
        }
    }

    const _findOpenOrigin = new THREE.Vector3();
    const _findOpenDir = new THREE.Vector3();
    const _findOpenBestDir = new THREE.Vector3();
    function findOpenDirection(bot, bvhMesh, scanRadius = 6, stepAngleDeg = 30) {
        let bestDistance = 0;
        let found = false;

        _findOpenOrigin.copy(bot.position);
        _findOpenOrigin.y += 0.1; // Raise ray above ground

        for (let angle = 0; angle < 360; angle += stepAngleDeg) {
            const radians = THREE.MathUtils.degToRad(angle);
            _findOpenDir.set(Math.cos(radians), 0, Math.sin(radians)).normalize();

            sharedRaycaster.set(_findOpenOrigin, _findOpenDir);
            sharedRaycaster.far = scanRadius;

            const hits = sharedRaycaster.intersectObject(bvhMesh, true);
            const distance = hits.length > 0 ? hits[0].distance : scanRadius;

            if (distance > bestDistance) {
                bestDistance = distance;
                _findOpenBestDir.copy(_findOpenDir);
                found = true;
            }
        }

        if (found) {
            return _findOpenOrigin.clone().add(_findOpenBestDir.multiplyScalar(Math.min(bestDistance, scanRadius)));
        }

        return null;
    }

    function calculateNextPosition(bot, desiredMovement, bvhMesh, delta) {
        const currentPos = bot.position;
        const nextPos = _testPos.copy(currentPos);

        // Horizontal movement with collision check
        if (desiredMovement.x !== 0 || desiredMovement.z !== 0) {
            _horizontalMove.set(desiredMovement.x, 0, desiredMovement.z);
            _testPos.copy(currentPos).add(_horizontalMove);

            // Use shared vector instead of clone
            _capsuleTestPos.copy(_testPos);
            _capsuleTestPos.y = currentPos.y;

            if (!checkCapsuleCollision(_capsuleTestPos, bvhMesh, botRadius, botHeight)) {
                nextPos.x = _testPos.x;
                nextPos.z = _testPos.z;
            }
            else {
                _xOffset.set(desiredMovement.x, 0, 0);
                _testPosX.copy(currentPos).add(_xOffset);

                _zOffset.set(0, 0, desiredMovement.z);
                _testPosZ.copy(currentPos).add(_zOffset);

                if (!checkCapsuleCollision(_testPosX, bvhMesh, botRadius, botHeight)) {
                    nextPos.x = _testPosX.x;
                }
                if (!checkCapsuleCollision(_testPosZ, bvhMesh, botRadius, botHeight)) {
                    nextPos.z = _testPosZ.z;
                }
            }
        }

        // Vertical movement
        const vMove = bot.fallVelocity * delta;
        if (Math.abs(vMove) > 0.001) {
            _vOffset.set(0, vMove, 0);
            _verticalMove.copy(nextPos).add(_vOffset);

            const groundHit = intersectsBelow(_verticalMove, bvhMesh, Math.abs(vMove) + 1.0);

            if (vMove < 0 && groundHit.length > 0) {
                nextPos.y = groundHit[0].point.y + botHeight / 2;
                bot.fallVelocity = 0;
                bot.isGrounded = true;
            } else if (
                !checkCapsuleCollision(_verticalMove, bvhMesh, botRadius, botHeight) ||
                (bot.jumping && vMove > 0)
            ) {
                nextPos.y = _verticalMove.y;
                bot.isGrounded = false;
            }
        }
        else if (bot.isGrounded) {
            const groundHit = intersectsBelow(nextPos, bvhMesh, 1.0);
            if (groundHit.length > 0) {
                nextPos.y = groundHit[0].point.y + botHeight / 2;
            }
        }

        return nextPos;
    }

    function checkCapsuleCollision(position, bvhMesh, radius, height) {
        if (!bvhMesh || !bvhMesh.geometry) {
            return false;
        }

        const halfHeight = height / 2;

        _capsuleStart.copy(position).addScaledVector(THREE.Object3D.DEFAULT_UP, -halfHeight + radius);
        _capsuleEnd.copy(position).addScaledVector(THREE.Object3D.DEFAULT_UP, halfHeight - radius);
        let hit = false;

        _capsuleBox.setFromPoints([_capsuleStart, _capsuleEnd]).expandByScalar(radius);

        bvhMesh.geometry.boundsTree.shapecast({
            bounds: _capsuleBox,

            intersectsBounds: box => box.intersectsBox(_capsuleBox),

            intersectsTriangle: tri => {
                _triSegment.start.copy(_capsuleStart);
                _triSegment.end.copy(_capsuleEnd);

                const distSq = tri.closestPointToSegment(_triSegment, _triClosestPoint, _triTmpVec);
                if (distSq < radius * radius) {
                    hit = true;
                    return true;
                }
                return false;
            }
        });

        return hit;
    }

    function checkGrounded(position, bvhMesh, maxDrop = 0.5) {
        _groundCheckPos.copy(position);
        return intersectsBelow(_groundCheckPos, bvhMesh, maxDrop + botHeight / 2).length > 0;
    }

    function hasLineOfSight(from, to, tempMesh) {
        _losFrom.copy(from).y += botHeight * 0.8; // Eye level
        _losTo.copy(to).y += botHeight * 0.8;

        _losDir.subVectors(_losTo, _losFrom).normalize();
        const distance = _losFrom.distanceTo(_losTo);

        sharedRaycaster.set(_losFrom, _losDir);
        sharedRaycaster.near = 0;
        sharedRaycaster.far = distance - 0.1; // Slight buffer to avoid self-intersection

        return sharedRaycaster.intersectObject(tempMesh, true).length === 0;
    }

    function intersectsBelow(position, tempMesh, maxDrop = 3) {
        _intersectsBelowOrigin.copy(position);
        _intersectsBelowOrigin.y += 0.1; // Start slightly above the position

        sharedRaycaster.set(_intersectsBelowOrigin, _intersectsBelowDir);
        sharedRaycaster.near = 0;
        sharedRaycaster.far = maxDrop + 0.1;

        return sharedRaycaster.intersectObject(tempMesh, true);
    }

    function tryShoot(delta, room, botId, origin, target) {
        const bot = bots[botId];
        if (!bot) return;

        // Cooldown
        if (bot.shotCooldown > 0) {
            bot.shotCooldown -= delta;
            return;
        }

        // Distance-based miss probability
        const distance = origin.distanceTo(target);
        const missChance = Math.min(0.95, 0.5 + distance / 50); // 50% to 95% chance to miss
        const willMiss = Math.random() < missChance;

        // Calculate direction
        _shootDir.subVectors(target, origin).normalize();

        // Miss by applying a random rotation
        if (willMiss) {
            let missAngle;
            switch (bot.weapon) {
                case "laser": missAngle = 1.2; break;       // ~69 degrees
                case "machinegun": missAngle = 1.5; break;  // ~86 degrees
                case "shotgun": missAngle = 2.5; break;     // ~143 degrees
                case "rocket": missAngle = 1.8; break;      // ~103 degrees
                default: missAngle = 1.5; break;
            }

            _randomAxis.set(Math.random(), Math.random(), Math.random()).normalize();
            _quaternion.setFromAxisAngle(_randomAxis, (Math.random() - 0.5) * missAngle);
            _shootDir.applyQuaternion(_quaternion).normalize();
        }

        // Fire and apply weapon-specific cooldown
        if (bot.weapon === "laser") {
            bot.shotCooldown = 1.0 + Math.random() * 0.5;
            const projectileId = `laser-${botId}-${Date.now()}-${localProjectileCounter++}`;
            laserSystem.spawnLaser(room.id, botId, origin, _shootDir, projectileId);
        }
        else if (bot.weapon === "shotgun") {
            bot.shotCooldown = 2.0 + Math.random() * 1.5;
            shotgunSystem.fire(
                { roomId: room.id, room, shooterId: botId, origin, direction: _shootDir },
                map => map.bvhMesh
            );
        }
        else if (bot.weapon === "machinegun") {
            bot.shotCooldown = 0.5 + Math.random() * 0.5;
            machinegunSystem.fire(
                { roomId: room.id, room, shooterId: botId, origin, direction: _shootDir },
                map => map.bvhMesh
            );
        }
        else if (bot.weapon === "rocket") {
            bot.shotCooldown = 3.0 + Math.random() * 2.0;
            const projectileId = `rocket-${botId}-${Date.now()}-${localProjectileCounter++}`;
            rocketSystem.launchRocket(room.id, projectileId, botId, origin, _shootDir, { ...origin });
        }
    }

    // Enhanced stuck detection and recovery system
    function handleStuckBot(bot, delta, tempMesh) {
        const STUCK_THRESHOLD = 0.05; // Minimum movement required
        const STUCK_TIME_THRESHOLD = 1.0; // Time before considering stuck
        const EMERGENCY_TELEPORT_TIME = 5.0; // Time before emergency teleport
        const MAX_UNSTUCK_ATTEMPTS = 3;
        const POSITION_HISTORY_SIZE = 10;

        // Update position history
        bot.positionHistory.push(bot.position.clone());
        if (bot.positionHistory.length > POSITION_HISTORY_SIZE) {
            bot.positionHistory.shift();
        }

        // Check if bot is stuck in geometry
        const isInGeometry = checkCapsuleCollision(bot.position, tempMesh, botRadius, botHeight);
        if (isInGeometry) {
            bot.isStuckInGeometry = true;
            bot.consecutiveStuckFrames++;

            // Immediate geometry escape attempt
            if (bot.consecutiveStuckFrames > 3) {
                return attemptGeometryEscape(bot, tempMesh);
            }
        } else {
            bot.isStuckInGeometry = false;
            bot.consecutiveStuckFrames = 0;
        }

        // Check movement over time
        const movementDelta = bot.position.distanceTo(bot.lastPosition);
        const isMoving = movementDelta > STUCK_THRESHOLD;

        if (!isMoving) {
            bot.stuckTimer += delta;
        } else {
            bot.stuckTimer = 0;
            bot.unstuckAttempts = 0;
        }

        // Update cooldowns
        if (bot.emergencyTeleportCooldown > 0) {
            bot.emergencyTeleportCooldown -= delta;
        }

        // Progressive unstuck attempts
        if (bot.stuckTimer >= STUCK_TIME_THRESHOLD) {
            return performUnstuckAction(bot, tempMesh, delta);
        }

        return null; // No unstuck action needed
    }

    // Attempt to escape from geometry collision
    const _escapeDir = new THREE.Vector3();
    const _escapeTestPos = new THREE.Vector3();
    const _escapeUp = new THREE.Vector3(0, 1, 0);
    const _geometryEscapeDirections = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 0, 1],
        [-1, 0, 1],
        [1, 0, -1],
        [-1, 0, -1],
        [0, 1, 0],
    ];
    function attemptGeometryEscape(bot, tempMesh) {
        const escapeDistance = botRadius * 2;

        for (const [x, y, z] of _geometryEscapeDirections) {
            _escapeDir.set(x, y, z).normalize().multiplyScalar(escapeDistance);
            _escapeTestPos.copy(bot.position).add(_escapeDir);

            if (!checkCapsuleCollision(_escapeTestPos, tempMesh, botRadius, botHeight)) {
                return _escapeTestPos.clone(); // return a safe copy
            }
        }

        // If all directions failed, try moving up more aggressively
        _escapeUp.set(0, botHeight, 0);
        _escapeTestPos.copy(bot.position).add(_escapeUp);

        if (!checkCapsuleCollision(_escapeTestPos, tempMesh, botRadius, botHeight)) {
            return _escapeTestPos.clone();
        }

        return null; // Couldn't escape, will need teleport
    }

    // Progressive unstuck actions
    function performUnstuckAction(bot, tempMesh, delta) {
        const currentTime = Date.now() / 1000;

        // Prevent too frequent unstuck attempts
        if (currentTime - bot.lastUnstuckTime < 0.5) {
            return null;
        }

        bot.lastUnstuckTime = currentTime;
        bot.unstuckAttempts++;

        switch (bot.unstuckAttempts) {
            case 1:
            case 2:
            case 3:
            case 4:
            case 5:
                // Try random movement first 5 times
                return attemptRandomMovement(bot, tempMesh);

            case 6:
            case 7:
                // Try jumping + movement
                return attemptJumpAndMove(bot, tempMesh, delta);

            case 8:
            case 9:
                // Try to find nearest open space
                return attemptNearestOpenSpace(bot, tempMesh);

            case 10:
            case 11:
            case 12:
                // One more open space attempt with larger radius (optional)
                return attemptNearestOpenSpace(bot, tempMesh);

            default:
                if (bot.emergencyTeleportCooldown <= 0) {
                    bot.emergencyTeleportCooldown = 10.0; // 10 second cooldown
                    return attemptEmergencyTeleport(bot, tempMesh);
                }
                break;
        }

        return null;
    }

    // Try moving in a random direction
    const _randMoveDir = new THREE.Vector3();
    const _randTestPos = new THREE.Vector3();
    const _randomDirections = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
        [1, 0, 1],
        [-1, 0, 1],
        [1, 0, -1],
        [-1, 0, -1],
    ];
    function attemptRandomMovement(bot, tempMesh) {
        const moveDistance = 2.0;

        // Shuffle _randomDirections (Fisher–Yates)
        for (let i = _randomDirections.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [_randomDirections[i], _randomDirections[j]] = [_randomDirections[j], _randomDirections[i]];
        }

        for (const [x, y, z] of _randomDirections) {
            _randMoveDir.set(x, y, z).normalize().multiplyScalar(moveDistance);
            _randTestPos.copy(bot.position).add(_randMoveDir);

            if (!checkCapsuleCollision(_randTestPos, tempMesh, botRadius, botHeight)) {
                const groundY = getYforXZ(tempMesh, _randTestPos.x, _randTestPos.z);
                _randTestPos.y = groundY;

                return _randTestPos.clone(); // return a safe copy
            }
        }

        return null;
    }


    // Try jumping and moving
    function attemptJumpAndMove(bot, tempMesh, delta) {
        // Force a jump
        bot.fallVelocity = 15; // Strong jump
        bot.isGrounded = false;
        bot.jumping = true;
        bot.jumpCooldown = 2.0;

        // Try to move in an open direction while jumping
        const openDirection = findOpenDirection(bot, tempMesh, 4, 45);
        if (openDirection) {
            return openDirection;
        }

        return null;
    }

    // Find the nearest completely open space
    const _nearestTestOffset = new THREE.Vector3();
    const _nearestTestPos = new THREE.Vector3();
    function attemptNearestOpenSpace(bot, tempMesh) {
        const searchRadius = 5.0;
        const stepSize = 1.0;
        const testPositions = [];

        // Generate test positions in a grid around the bot
        for (let x = -searchRadius; x <= searchRadius; x += stepSize) {
            for (let z = -searchRadius; z <= searchRadius; z += stepSize) {
                _nearestTestOffset.set(x, 0, z);
                _nearestTestPos.copy(bot.position).add(_nearestTestOffset);

                const groundY = getYforXZ(tempMesh, _nearestTestPos.x, _nearestTestPos.z);
                _nearestTestPos.y = groundY;

                testPositions.push({
                    position: _nearestTestPos.clone(), // store copy for later use
                    distance: bot.position.distanceTo(_nearestTestPos)
                });
            }
        }

        // Sort by distance (closest first)
        testPositions.sort((a, b) => a.distance - b.distance);

        // Find the first valid position
        for (const test of testPositions) {
            if (!checkCapsuleCollision(test.position, tempMesh, botRadius, botHeight)) {
                const hasSpace = checkSurroundingSpace(test.position, tempMesh, botRadius * 1.5);
                if (hasSpace) {
                    return test.position;
                }
            }
        }

        return null;
    }

    // Check if there's enough space around a position
    const _dir = new THREE.Vector3();
    const _checkPos = new THREE.Vector3();
    const _surroundingSpaceDirections = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
    ];
    function checkSurroundingSpace(position, tempMesh, checkRadius) {
        for (let i = 0; i < _surroundingSpaceDirections.length; i++) {
            const [x, y, z] = _surroundingSpaceDirections[i];
            _dir.set(x, y, z).multiplyScalar(checkRadius);
            _checkPos.copy(position).add(_dir);

            if (checkCapsuleCollision(_checkPos, tempMesh, botRadius, botHeight)) {
                return false;
            }
        }

        return true;
    }

    // Emergency teleport to spawn area
    const _emergencyTeleportPos = new THREE.Vector3();
    function attemptEmergencyTeleport(bot, tempMesh) {

        const bounds = getXZBoundsFromBVH(tempMesh);
        const maxAttempts = 20;

        for (let i = 0; i < maxAttempts; i++) {
            const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
            const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
            const y = getYforXZ(tempMesh, x, z);

            _emergencyTeleportPos.set(x, y, z);

            if (!checkCapsuleCollision(_emergencyTeleportPos, tempMesh, botRadius, botHeight)) {
                // Reset bot state
                bot.stuckTimer = 0;
                bot.unstuckAttempts = 0;
                bot.fallVelocity = 0;
                bot.isGrounded = true;
                bot.jumping = false;
                return _emergencyTeleportPos.clone(); // Return a safe copy
            }
        }
        return null;
    }

    return {
        spawnBot,
        update
    };
}