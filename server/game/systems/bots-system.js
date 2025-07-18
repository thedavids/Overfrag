import { EventBus } from '../shared/event-bus.js';
import * as THREE from 'three';

export function createBotsSystem({ laserSystem, shotgunSystem, machinegunSystem, rocketSystem, health }) {
    const bots = {};
    const tempMesh = new THREE.Mesh();
    const botRadius = 0.3;
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
            weapon: weapon
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
        tempMesh.geometry = bvhMesh;

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

    function getYforXZ(bvhMesh, x, z) {
        let y = 200; // fallback spawn height

        if (bvhMesh) {
            tempMesh.geometry = bvhMesh;
            const rayOrigin = new THREE.Vector3(x, 1000, z); // cast from high above
            const raycaster = new THREE.Raycaster(rayOrigin, new THREE.Vector3(0, -1, 0), 0, 2000);
            const hits = raycaster.intersectObject(tempMesh, true);

            if (hits.length > 0) {
                y = hits[0].point.y + 50; // 50 above the ground
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
    const _checkPos = new THREE.Vector3();
    const _checkDir = new THREE.Vector3();
    const _collisionDirs = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(1, 0, 1).normalize(),
        new THREE.Vector3(-1, 0, -1).normalize(),
        new THREE.Vector3(1, 0, -1).normalize(),
        new THREE.Vector3(-1, 0, 1).normalize(),
        new THREE.Vector3(0, 1, 0) // upward
    ];
    const _groundCheckPos = new THREE.Vector3();
    const _losFrom = new THREE.Vector3();
    const _losTo = new THREE.Vector3();
    const _losDir = new THREE.Vector3();
    const _intersectsBelowOrigin = new THREE.Vector3();
    const _intersectsBelowDir = new THREE.Vector3(0, -1, 0);
    const _shootDir = new THREE.Vector3();
    const _randomAxis = new THREE.Vector3();
    const _quaternion = new THREE.Quaternion();

    function update(delta) {
        delta = delta / 1000;

        for (const botId in bots) {
            const bot = bots[botId];
            if (bot.isDead) continue;

            if (bot.jumpCooldown > 0) {
                bot.jumpCooldown -= delta;
            }

            const bvhMesh = bot.room.map?.bvhMesh;
            if (!bvhMesh) return;

            tempMesh.geometry = bvhMesh;

            const players = Object.entries(bot.room.players).filter(([id, p]) => id !== botId);
            if (players.length === 0) continue;

            // Choose closest player
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
            const targetPos = targetPlayer?.position;

            // Line of sight
            const hasLOS = hasLineOfSight(bot.position, targetPos, tempMesh);
            if (hasLOS) {
                tryShoot(delta, bot.room, botId, bot.position, targetPos);
            }

            // Movement
            _moveDir.subVectors(targetPos, bot.position).normalize();
            const speed = 7;
            const distanceToTarget = bot.position.distanceTo(targetPos);
            const minDistance = 10;

            if (distanceToTarget > minDistance) {
                _desiredMovement.copy(_moveDir).multiplyScalar(speed * delta);
            }
            else {
                if (!bot.idleDir || Math.random() < 0.02) {
                    const angle = Math.random() * Math.PI * 2;
                    if (bot.idleDir == null) {
                        bot.idleDir = new THREE.Vector3();
                    }
                    bot.idleDir.set(Math.cos(angle), 0, Math.sin(angle)).normalize();
                }
                _desiredMovement.copy(bot.idleDir).multiplyScalar(speed * delta);
            }

            bot.isGrounded = checkGrounded(bot.position, tempMesh);

            // Detect if stuck
            _movementDelta.subVectors(bot.position, bot.lastPosition);
            const stuckThreshold = 0.02;
            const stuckDuration = 1.5;

            if (_movementDelta.lengthSq() > stuckThreshold * stuckThreshold && bot.isGrounded) {
                bot.stuckTimer += delta;
            } else {
                bot.stuckTimer = 0;
                bot.jumping = false;
            }

            if (bot.stuckTimer >= stuckDuration && bot.isGrounded && !bot.jumping) {
                bot.fallVelocity = 12;
                bot.isGrounded = false;
                bot.jumping = true;
                bot.stuckTimer = 0;
            }

            if (bot.isGrounded && !bot.jumping && bot.jumpCooldown <= 0 && Math.random() < 0.02) {
                bot.fallVelocity = 12;
                bot.isGrounded = false;
                bot.jumping = true;
                bot.jumpCooldown = 2.0;
            }

            const gravity = -20;
            if (!bot.isGrounded) {
                bot.fallVelocity += gravity * delta;
            } else {
                bot.fallVelocity = 0;
            }

            const nextPos = calculateNextPosition(bot, _desiredMovement, tempMesh, delta);
            if (bot.isGrounded) bot.jumping = false;

            bot.position.copy(nextPos);
            bot.room.players[botId].position = nextPos;

            const isIdle = _desiredMovement.lengthSq() < 0.001 * 0.001;

            _lookDir.subVectors(targetPos, bot.position);
            _lookDir.y = 0;
            _lookDir.normalize();
            bot.rotation.set(0, Math.atan2(_lookDir.x, _lookDir.z) + Math.PI, 0);

            EventBus.emit("botsSystem:moved", {
                botId,
                room: bot.room,
                position: bot.position,
                rotation: bot.rotation,
                isIdle: isIdle,
                isGrounded: true
            });

            bot.lastPosition.copy(bot.position);
        }
    }

    function calculateNextPosition(bot, desiredMovement, bvhMesh, delta) {
        const currentPos = bot.position;
        const nextPos = _testPos.copy(currentPos);

        // Horizontal movement with collision check
        if (desiredMovement.x !== 0 || desiredMovement.z !== 0) {
            _horizontalMove.set(desiredMovement.x, 0, desiredMovement.z);
            _testPos.copy(currentPos).add(_horizontalMove);

            if (!checkCollision(_testPos, bvhMesh, botRadius, botHeight)) {
                nextPos.x = _testPos.x;
                nextPos.z = _testPos.z;
            } else {
                _testPosX.set(desiredMovement.x, 0, 0).add(currentPos);
                _testPosZ.set(0, 0, desiredMovement.z).add(currentPos);

                if (!checkCollision(_testPosX, bvhMesh, botRadius, botHeight)) nextPos.x = _testPosX.x;
                if (!checkCollision(_testPosZ, bvhMesh, botRadius, botHeight)) nextPos.z = _testPosZ.z;
            }
        }

        // Vertical movement
        const vMove = bot.fallVelocity * delta;
        if (Math.abs(vMove) > 0.001) {
            _verticalMove.set(0, vMove, 0).add(nextPos);
            const groundHit = intersectsBelow(_verticalMove, bvhMesh, Math.abs(vMove) + 0.5);

            if (vMove < 0 && groundHit.length > 0) {
                nextPos.y = groundHit[0].point.y + botHeight / 2;
                bot.fallVelocity = 0;
                bot.isGrounded = true;
            }
            else if (!checkCollision(_verticalMove, bvhMesh, botRadius, botHeight)) {
                nextPos.y = _verticalMove.y;
                bot.isGrounded = false;
            }
        }
        else if (bot.isGrounded) {
            const groundHit = intersectsBelow(nextPos, bvhMesh, 0.5);
            if (groundHit.length > 0) {
                nextPos.y = groundHit[0].point.y + botHeight / 2;
            }
        }

        return nextPos.clone(); // return a copy in case nextPos is reused elsewhere
    }

    function checkCollision(position, bvhMesh, radius, height) {
        const checkHeights = [0.1, height * 0.5, height * 0.9];

        for (const h of checkHeights) {
            _checkPos.copy(position).y += h;

            for (let i = 0; i < _collisionDirs.length; i++) {
                _checkDir.copy(_collisionDirs[i]);

                sharedRaycaster.set(_checkPos, _checkDir);
                sharedRaycaster.far = radius;

                if (sharedRaycaster.intersectObject(bvhMesh, true).length > 0) {
                    return true;
                }
            }
        }

        return false;
    }

    function checkGrounded(position, bvhMesh, maxDrop = 0.5) {
        _groundCheckPos.copy(position).y -= botHeight / 2;
        return intersectsBelow(_groundCheckPos, bvhMesh, maxDrop).length > 0;
    }

    function hasLineOfSight(from, to, bvhMesh) {
        _losFrom.copy(from).y += 1.5;
        _losTo.copy(to).y += 1.5;

        _losDir.subVectors(_losTo, _losFrom).normalize();
        const distance = _losFrom.distanceTo(_losTo);

        sharedRaycaster.set(_losFrom, _losDir);
        sharedRaycaster.far = distance;

        return sharedRaycaster.intersectObject(bvhMesh, true).length === 0;
    }

    function intersectsBelow(position, bvhMesh, maxDrop = 3) {
        _intersectsBelowOrigin.copy(position).y += 0.6;
        sharedRaycaster.set(_intersectsBelowOrigin, _intersectsBelowDir);
        sharedRaycaster.far = maxDrop + 0.6;
        return sharedRaycaster.intersectObject(bvhMesh, true);
    }

    function tryShoot(delta, room, botId, origin, target) {
        const bot = bots[botId];
        if (!bot) return;

        if (bot.shotCooldown > 0) {
            bot.shotCooldown -= delta;
            return;
        }



        // 9/10 chance to miss
        const willMiss = Math.random() < 0.9;

        _shootDir.subVectors(target, origin).normalize();

        if (willMiss) {
            const missAngle = 0.5; // radians
            _randomAxis.set(Math.random(), Math.random(), Math.random()).normalize();
            _quaternion.setFromAxisAngle(_randomAxis, (Math.random() - 0.5) * missAngle);
            _shootDir.applyQuaternion(_quaternion).normalize();
        }

        if (bot.weapon === "laser") {

            bot.shotCooldown = 0.3 + Math.random() * 0.5;
            const projectileId = `laser-${botId}-${Date.now()}-${localProjectileCounter++}`;
            laserSystem.spawnLaser(room.id, botId, origin, _shootDir, projectileId);
        }
        else if (bot.weapon === "shotgun") {
            bot.shotCooldown = 1.2 + Math.random() * 1.2;
            shotgunSystem.fire(
                { roomId: room.id, room, shooterId: botId, origin, direction: _shootDir },
                map => map.bvhMesh
            );
        }
        else if (bot.weapon === "machinegun") {
            bot.shotCooldown = 0.2 + Math.random() * 0.2;
            machinegunSystem.fire(
                { roomId: room.id, room, shooterId: botId, origin, direction: _shootDir },
                map => map.bvhMesh
            );
        }
        else if (bot.weapon === "rocket") {
            bot.shotCooldown = 1.5 + Math.random() * 1.5;
            const projectileId = `rocket-${botId}-${Date.now()}-${localProjectileCounter++}`;
            rocketSystem.launchRocket(room.id, projectileId, botId, origin, _shootDir, { ...origin });
        }
    }

    return {
        spawnBot,
        update
    };
}
