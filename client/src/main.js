import './style.css';
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OctreeNode, computeMapBounds, EventBus, TexturesDictionary, ModelsDictionary, GameState, createMapSystem } from 'shared';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { io } from 'socket.io-client';
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Socket setup
const socket = io(import.meta.env.VITE_SOCKET_URL);

// Three.js setup
const scene = new THREE.Scene();
const clock = new THREE.Clock();
const renderer = new THREE.WebGLRenderer();

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 1);
directional.position.set(5, 10, 7);
scene.add(directional);

const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-5, -10, -7);
scene.add(fill);

document.getElementById('canvas-container').appendChild(renderer.domElement);

renderer.setSize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', () => {
    CameraSystem.getCamera().aspect = window.innerWidth / window.innerHeight;
    CameraSystem.getCamera().updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    CameraSystem.getHudCamera().right = window.innerWidth;
    CameraSystem.getHudCamera().top = window.innerHeight;
    CameraSystem.getHudCamera().updateProjectionMatrix();
    UISystem.updateCrosshairPosition();
});

const PLAYER_CAPSULE_RADIUS = 0.3;
const PLAYER_CAPSULE_HEIGHT = 1.2;

// === InputSystem Start ===
const InputSystem = (() => {
    const keyState = {};
    let lookTouchId = null;
    let lastTouchPos = null;
    let jumpRequested = false;
    let jumpRequestTime = 0;
    const JUMP_BUFFER_TIME = 200;

    let playerYaw = 0;
    let playerPitch = 0;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function getLookAngles() {
        return { playerYaw, playerPitch };
    }

    function requestJump() {
        jumpRequested = true;
        jumpRequestTime = performance.now();
    }

    function isJumpBuffered() {
        return jumpRequested && performance.now() - jumpRequestTime < JUMP_BUFFER_TIME;
    }

    function clearJumpBuffer() {
        jumpRequested = false;
    }

    function getKeyState() {
        return keyState;
    }

    function isGameStarted() {
        return !!gameState.playerObj;
    }

    function setup() {
        const keyMap = {
            up: 'w', down: 's', left: 'a', right: 'd',
            jump: ' ', fire: 'f', grapple: 'g', toggleView: 'v'
        };

        document.addEventListener('keydown', e => {
            if (!isGameStarted()) return;

            const key = e.key.toLowerCase();
            keyState[key] = true;

            if (key === ' ') requestJump();
            else if (key === 'g') EventBus.emit("input:fireGrapple");
            else if (key === 'f') EventBus.emit("input:shootBegin");
            else if (key === 'v') EventBus.emit("input:toggleView");
            else if (key === '1') EventBus.emit("input:switchWeapon", { weaponId: 1 });
            else if (key === '2') EventBus.emit("input:switchWeapon", { weaponId: 2 });
            else if (key === '3') EventBus.emit("input:switchWeapon", { weaponId: 3 });
            else if (key === '4') EventBus.emit("input:switchWeapon", { weaponId: 4 });
        });

        document.addEventListener('keyup', e => {
            if (!isGameStarted()) return;

            const key = e.key.toLowerCase();
            keyState[key] = false;

            if (key === 'g') {
                EventBus.emit("input:releaseGrapple");
            }
            if (key === 'f') {
                EventBus.emit("input:shootEnd");
            }
        });

        // Touch buttons
        const btnJump = document.getElementById('btn-jump');
        const btnFire = document.getElementById('btn-fire');
        const btnGrapple = document.getElementById('btn-grapple');

        btnJump.addEventListener('touchstart', (e) => {
            e.preventDefault();
            requestJump();
        }, { passive: false });

        if (btnFire) {
            btnFire.addEventListener('touchstart', (e) => {
                e.preventDefault();
                EventBus.emit("input:shootBegin");
            }, { passive: false });
            ['touchend', 'touchcancel'].forEach(evt =>
                btnFire.addEventListener(evt, () => EventBus.emit("input:shootEnd"))
            );
        }

        if (btnGrapple) {
            btnGrapple.addEventListener('touchstart', (e) => {
                e.preventDefault();
                EventBus.emit("input:fireGrapple");
            }, { passive: false });
            ['touchend', 'touchcancel'].forEach(evt =>
                btnGrapple.addEventListener(evt, () => EventBus.emit("input:releaseGrapple"))
            );
        }

        const btnSwitch = document.getElementById('btn-switch');
        if (btnSwitch) {
            btnSwitch.addEventListener('touchstart', (e) => {
                e.preventDefault();
                EventBus.emit("input:nextWeapon");
            }, { passive: false });
        }

        const wheel = document.getElementById('touch-wheel');
        let wheelTouchId = null;
        let wheelStart = null;

        const keyMapWheel = { up: 'w', down: 's', left: 'a', right: 'd' };

        function updateDirectionFromAngle(angle) {
            for (const key of Object.values(keyMapWheel)) keyState[key] = false;

            if (angle >= -Math.PI / 4 && angle < Math.PI / 4) {
                keyState[keyMapWheel.right] = true;
            } else if (angle >= Math.PI / 4 && angle < 3 * Math.PI / 4) {
                keyState[keyMapWheel.down] = true;
            } else if (angle >= -3 * Math.PI / 4 && angle < -Math.PI / 4) {
                keyState[keyMapWheel.up] = true;
            } else {
                keyState[keyMapWheel.left] = true;
            }
        }

        if (wheel) {
            wheel.addEventListener('touchstart', (e) => {
                const touch = e.changedTouches[0];
                wheelTouchId = touch.identifier;
                wheelStart = { x: touch.clientX, y: touch.clientY };

                const rect = wheel.getBoundingClientRect();
                const center = {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };

                const dx = touch.clientX - center.x;
                const dy = touch.clientY - center.y;
                const angle = Math.atan2(dy, dx);
                updateDirectionFromAngle(angle);

                e.preventDefault();
            }, { passive: false });

            wheel.addEventListener('touchmove', (e) => {
                const touch = [...e.touches].find(t => t.identifier === wheelTouchId);
                if (!touch || !wheelStart) return;

                const dx = touch.clientX - wheelStart.x;
                const dy = touch.clientY - wheelStart.y;

                if (Math.hypot(dx, dy) > 10) {
                    const angle = Math.atan2(dy, dx);
                    updateDirectionFromAngle(angle);
                }

                e.preventDefault();
            }, { passive: false });

            const clearWheel = () => {
                wheelTouchId = null;
                wheelStart = null;
                for (const key of Object.values(keyMapWheel)) keyState[key] = false;
            };

            wheel.addEventListener('touchend', (e) => {
                if ([...e.changedTouches].some(t => t.identifier === wheelTouchId)) {
                    clearWheel();
                }
            });

            wheel.addEventListener('touchcancel', (e) => {
                clearWheel();
            });
        }

        document.addEventListener('gesturestart', e => e.preventDefault());
        document.addEventListener('gesturechange', e => e.preventDefault());
        document.addEventListener('gestureend', e => e.preventDefault());

        const isTouchDevice = () => (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            navigator.userAgent.includes('iPad') // covers iPadOS
        );

        document.addEventListener('mousedown', (e) => {
            if (!isGameStarted()) return;
            if (isTouchDevice()) return;

            // left click
            if (e.button === 0) {
                EventBus.emit("input:shootBegin");
            }
            // middle mouse button
            else if (e.button === 1 || e.button === 2) {
                EventBus.emit("input:fireGrapple");
                e.preventDefault();
            }
        });

        document.addEventListener('mouseup', (e) => {
            if (!isGameStarted()) return;
            if (isTouchDevice()) return;

            // left click
            if (e.button === 0) {
                EventBus.emit("input:shootEnd");
            }
            // release middle mouse stops grappling
            else if (e.button === 1 || e.button === 2) {
                EventBus.emit("input:releaseGrapple");
                e.preventDefault();
            }
        });
    }

    function setupLookControls() {

        function enablePointerLock() {
            if (isGameStarted()) {
                document.body.requestPointerLock();
            }
        }

        // Mouse look
        function onMouseMove(e) {
            playerYaw -= e.movementX * 0.002;
            playerPitch -= e.movementY * 0.002;
            playerPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerPitch));
        }

        document.addEventListener('pointerlockchange', () => {
            const locked = document.pointerLockElement === document.body;
            if (locked) {
                document.addEventListener('mousemove', onMouseMove);
            } else {
                document.removeEventListener('mousemove', onMouseMove);
            }
        });

        document.addEventListener('click', () => {
            if (!isGameStarted()) return;

            const isPointerLocked = document.pointerLockElement === document.body;

            if (!isPointerLocked) {
                enablePointerLock(); // Only locks pointer on first click
            }
        });

        // Touch look
        document.addEventListener('touchstart', (e) => {
            if (!isGameStarted()) return;

            for (const touch of e.changedTouches) {
                if (lookTouchId === null && !touch.target.closest('#touch-controls')) {
                    lookTouchId = touch.identifier;
                    lastTouchPos = { x: touch.clientX, y: touch.clientY };
                }
            }
        }, false);

        document.addEventListener('touchmove', (e) => {
            if (!isGameStarted()) return;

            for (const touch of e.changedTouches) {
                if (touch.identifier === lookTouchId && lastTouchPos) {
                    const deltaX = touch.clientX - lastTouchPos.x;
                    const deltaY = touch.clientY - lastTouchPos.y;

                    playerYaw -= deltaX * 0.008;
                    playerPitch -= deltaY * 0.008;
                    playerPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerPitch));

                    lastTouchPos = { x: touch.clientX, y: touch.clientY };
                }
            }
        }, false);

        ['touchend', 'touchcancel'].forEach(evt =>
            document.addEventListener(evt, (e) => {
                if (!isGameStarted()) return;

                for (const touch of e.changedTouches) {
                    if (touch.identifier === lookTouchId) {
                        lookTouchId = null;
                        lastTouchPos = null;
                    }
                }
            }, false)
        );
    }

    return {
        setup,
        setupLookControls,
        getKeyState,
        getLookAngles,
        isJumpBuffered,
        clearJumpBuffer,
        requestJump
    };
})();
InputSystem.setup();
InputSystem.setupLookControls();
// === InputSystem End ===

// === DamageNumberPool Begin ===
const DamageNumberPool = (() => {
    const pool = [];
    const inUse = new Set();

    for (let i = 0; i < 30; i++) {
        const sprite = new THREE.Sprite();
        sprite.scale.set(1, 0.5, 1);
        sprite.material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
        sprite.visible = false;
        sprite.userData = { active: false };
        scene.add(sprite);
        pool.push(sprite);
    }

    return {
        getSprite() {
            for (const sprite of pool) {
                if (!inUse.has(sprite)) {
                    inUse.add(sprite);
                    sprite.visible = true;
                    return sprite;
                }
            }

            // Fallback if all are used
            const sprite = new THREE.Sprite();
            sprite.material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
            sprite.scale.set(1, 0.5, 1);
            scene.add(sprite);
            inUse.add(sprite);
            return sprite;
        },

        releaseSprite(sprite) {
            sprite.visible = false;
            inUse.delete(sprite);
        }
    };
})();
// === DamageNumberPool End ===

// === DamageTexturePool Begin ===
const DamageTexturePool = (() => {
    const cache = new Map();

    function createCanvasTexture(damage, color) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext("2d");

        ctx.font = "bold 48px Arial";
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#000000";
        ctx.fillStyle = color;

        const text = damage.toString();
        ctx.strokeText(text, canvas.width / 2, 48);
        ctx.fillText(text, canvas.width / 2, 48);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        texture.encoding = THREE.sRGBEncoding;

        return texture;
    }

    return {
        get(damage, color = "#ffffff") {
            const key = `${damage}|${color}`;
            if (!cache.has(key)) {
                cache.set(key, createCanvasTexture(damage, color));
            }
            return cache.get(key);
        }
    };
})();
// === DamageTexturePool End ===

// === EffectSystem Begin ===
const EffectSystem = (() => {
    const damageNumbers = [];
    const hitEffects = [];
    const bloodParticles = [];
    const muzzleFlashes = [];
    const activeTracers = [];
    const activeRocketExplosions = [];

    // Shared blood geometry and material
    const sharedBloodGeometry = new THREE.SphereGeometry(0.05, 4, 4);
    const sharedBloodMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });

    // Rockets
    const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.5 });

    EventBus.on("player:tookDamage", ({ position, health, damage }) => {
        createBloodAnimation(position, 10);
        showDamageNumber(position, damage);
    });
    EventBus.on("player:died", ({ playerId, message, position }) => createBloodAnimation(position, 30));

    function createBloodAnimation(position, particleCount) {
        const fixedPos = new THREE.Vector3(position.x, position.y, position.z);

        for (let i = 0; i < particleCount; i++) {
            const particle = new THREE.Mesh(sharedBloodGeometry, sharedBloodMaterial);

            particle.position.copy(fixedPos);

            const velocity = new THREE.Vector3(
                (Math.random() - 0.5),
                Math.random(),
                (Math.random() - 0.5)
            ).normalize().multiplyScalar(Math.random() * 2);

            const life = 2.0 + Math.random() * 0.5;

            bloodParticles.push({ sprite: particle, velocity, life });
            scene.add(particle);
        }
    }

    function showDamageNumber(position, damage, color = "#ffffff") {
        const duration = 0.8; // seconds

        const startPos = new THREE.Vector3(position.x, position.y + 1.6, position.z);
        const floatOffset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.3,
            0.8 + Math.random() * 0.3,
            (Math.random() - 0.5) * 0.3
        );

        const sprite = DamageNumberPool.getSprite();
        const texture = DamageTexturePool.get(damage, color);
        const material = sprite.material;
        material.map = texture;
        material.opacity = 1;

        sprite.position.copy(startPos);
        sprite.scale.set(damage >= 20 ? 1.5 : 1.1, damage >= 20 ? 0.75 : 0.55, 1);
        scene.add(sprite);

        damageNumbers.push({ sprite, material, startPos, floatOffset, elapsed: 0, duration });
    }

    function spawnMuzzleFlash(position, direction) {
        const flashPos = position.clone().add(direction.clone().multiplyScalar(0.2));
        const size = 0.3 + Math.random() * 0.2;

        // === Create texture and material once ===
        if (!spawnMuzzleFlash.texture) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 64;
            const ctx = canvas.getContext('2d');
            const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            grd.addColorStop(0, '#ffffff');
            grd.addColorStop(0.3, '#ffaa00');
            grd.addColorStop(1, 'transparent');
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, 64, 64);

            const texture = new THREE.CanvasTexture(canvas);
            const material = new THREE.SpriteMaterial({ map: texture, transparent: true });

            spawnMuzzleFlash.texture = texture;
            spawnMuzzleFlash.material = material;
        }

        // === Reuse material (no clone)
        const sprite = new THREE.Sprite(spawnMuzzleFlash.material);
        sprite.position.copy(flashPos);
        sprite.scale.set(size, size, 1);
        scene.add(sprite);

        const light = new THREE.PointLight(0xffaa00, 5, 10);
        light.position.copy(flashPos);
        scene.add(light);

        muzzleFlashes.push({
            sprite,
            light,
            baseScale: size,
            elapsed: 0,
            duration: 0.1
        });
    }

    function spawnTracer(origin, direction, length = 4) {
        const radius = 0.01;
        const geometry = new THREE.CylinderGeometry(radius, radius, length, 6, 1, true);
        const material = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
        const tracer = new THREE.Mesh(geometry, material);

        const midPoint = origin.clone().add(direction.clone().multiplyScalar(length / 2));
        tracer.position.copy(midPoint);

        const quat = new THREE.Quaternion();
        quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
        tracer.quaternion.copy(quat);

        scene.add(tracer);

        activeTracers.push({
            mesh: tracer,
            geometry,
            material,
            elapsed: 0,
            duration: 0.08 // seconds
        });
    }

    const smokeMaterialPool = [];

    function getPooledMaterial(texture) {
        return smokeMaterialPool.pop() || new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
    }

    function returnMaterialToPool(material) {
        material.opacity = 0.6;
        smokeMaterialPool.push(material);
    }

    async function spawnHitEffect(position, normal) {
        const texture = await TexturesDictionary.get(
            'smokeTransparent',
            'https://www.dailysummary.io/textures/smoke_transparent.png'
        );

        const puffCount = 2 + Math.floor(Math.random() * 2);

        for (let i = 0; i < puffCount; i++) {
            const offset = new THREE.Vector3(
                (Math.random() - 0.5) * 0.1,
                (Math.random() - 0.5) * 0.1,
                (Math.random() - 0.5) * 0.1
            );

            const mat = getPooledMaterial(texture);
            const sprite = new THREE.Sprite(mat);
            sprite.position.copy(position.clone().add(normal.clone().multiplyScalar(0.05)).add(offset));
            sprite.scale.setScalar(0.4 + Math.random() * 0.2);
            scene.add(sprite);

            const baseScale = sprite.scale.x;

            hitEffects.push({
                sprite,
                baseScale,
                elapsed: 0,
                duration: 0.4 // seconds
            });
        }
    }

    function createRocketExplosion(position) {
        const geometry = new THREE.SphereGeometry(1, 16, 16);
        const mesh = new THREE.Mesh(geometry, explosionMaterial.clone());
        mesh.position.copy(position);
        mesh.scale.set(0.01, 0.01, 0.01); // start tiny
        scene.add(mesh);

        activeRocketExplosions.push({
            mesh,
            geometry,
            material: mesh.material,
            elapsed: 0,
            duration: 0.5 // seconds
        });
    }
    // === Temp vectors for animation math ===
    const _tempVec1 = new THREE.Vector3();
    const _tempVec2 = new THREE.Vector3();

    function update(delta) {
        // === Damage Numbers ===
        for (let i = damageNumbers.length - 1; i >= 0; i--) {
            const dn = damageNumbers[i];
            dn.elapsed += delta;
            const t = dn.elapsed / dn.duration;

            if (t >= 1) {
                DamageNumberPool.releaseSprite(dn.sprite);
                damageNumbers.splice(i, 1);
                continue;
            }

            _tempVec1.copy(dn.floatOffset).multiplyScalar(t);
            dn.sprite.position.copy(_tempVec2.copy(dn.startPos).add(_tempVec1));
            dn.material.opacity = 1 - t;
        }

        // === Hit Effect Puffs ===
        for (let i = hitEffects.length - 1; i >= 0; i--) {
            const p = hitEffects[i];
            p.elapsed += delta;
            const t = p.elapsed / p.duration;

            if (t >= 1) {
                scene.remove(p.sprite);
                returnMaterialToPool(p.sprite.material);
                hitEffects.splice(i, 1);
                continue;
            }

            const scale = p.baseScale + t * 0.5;
            p.sprite.scale.set(scale, scale, scale);
            p.sprite.material.opacity = 0.6 * (1 - t);
        }

        // === Blood Particles ===
        for (let i = bloodParticles.length - 1; i >= 0; i--) {
            const p = bloodParticles[i];
            p.sprite.position.addScaledVector(p.velocity, delta);
            p.life -= delta;

            if (p.life <= 0) {
                scene.remove(p.sprite);
                bloodParticles.splice(i, 1);
            }
        }

        // === Muzzle Flashes ===
        for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
            const flash = muzzleFlashes[i];
            flash.elapsed += delta;

            const t = flash.elapsed / flash.duration;
            if (t >= 1) {
                scene.remove(flash.sprite);
                scene.remove(flash.light);
                flash.sprite.material.dispose();
                muzzleFlashes.splice(i, 1);
                continue;
            }

            const scale = flash.baseScale * (1 + t * 0.5);
            flash.sprite.scale.set(scale, scale, 1);
            flash.sprite.material.opacity = 1 - t;
        }

        // === Tracers ===
        for (let i = activeTracers.length - 1; i >= 0; i--) {
            const tracer = activeTracers[i];
            tracer.elapsed += delta;

            if (tracer.elapsed >= tracer.duration) {
                scene.remove(tracer.mesh);
                tracer.geometry.dispose();
                tracer.material.dispose();
                activeTracers.splice(i, 1);
            }
        }

        // === Explosions ===
        for (let i = activeRocketExplosions.length - 1; i >= 0; i--) {
            const explosion = activeRocketExplosions[i];
            explosion.elapsed += delta;

            const t = explosion.elapsed / explosion.duration;
            const scale = THREE.MathUtils.lerp(0.01, 2.5, t);
            explosion.mesh.scale.set(scale, scale, scale);
            explosion.material.opacity = 1.0 - t;

            if (explosion.elapsed >= explosion.duration) {
                scene.remove(explosion.mesh);
                explosion.geometry.dispose();
                explosion.material.dispose();
                activeRocketExplosions.splice(i, 1);
            }
        }
    }

    return {
        createBloodAnimation,
        spawnMuzzleFlash,
        spawnTracer,
        spawnHitEffect,
        createRocketExplosion,
        update
    };
})();
// === EffectSystem End ===

// === CameraSystem Begin ===
const CameraSystem = (() => {
    let firstPerson = false;
    let camera;
    let hudCamera;
    let raycaster;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function initCamera() {
        camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
        camera.position.set(0, 2, 6);
        scene.add(camera);
        hudCamera = new THREE.OrthographicCamera(0, window.innerWidth, window.innerHeight, 0, -10, 10);
        raycaster = new THREE.Raycaster();
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
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        raycaster.far = maxDistance;

        const origin = raycaster.ray.origin.clone();
        const direction = raycaster.ray.direction.clone();

        // === 1. World hit (via octree) ===
        const worldCandidates = octree.queryRay(origin, direction, maxDistance);
        const worldHits = raycaster.intersectObjects(worldCandidates, true);
        const worldHitPoint = worldHits.length > 0 ? worldHits[0].point : null;

        // === 2. Player hit (scan players manually) ===
        let hitPlayer = null;
        let hitPlayerPoint = null;
        let nearestPlayerDist = Infinity;

        for (const id in gameState.players) {
            const player = gameState.players[id];
            if (id === gameState.playerId) continue;

            const bbox = new THREE.Box3().setFromObject(player);
            if (!bbox.isEmpty()) {
                const hit = raycaster.ray.intersectBox(bbox, new THREE.Vector3());
                if (hit) {
                    const dist = origin.distanceTo(hit);
                    if (dist < nearestPlayerDist) {
                        nearestPlayerDist = dist;
                        hitPlayer = player;
                        hitPlayerPoint = hit.clone();
                    }
                }
            }
        }

        // === 3. Decide which hit to use ===
        let finalPoint = origin.clone().add(direction.clone().multiplyScalar(maxDistance));
        if (worldHitPoint && (!hitPlayerPoint || origin.distanceTo(worldHitPoint) < nearestPlayerDist)) {
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

        const { playerYaw, playerPitch } = InputSystem.getLookAngles();

        // Calculate desired camera position
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
        const possibleHits = octree.queryRay(rayOrigin, cameraDir, distance);
        raycaster.set(rayOrigin, cameraDir);
        raycaster.far = distance;
        const intersections = raycaster.intersectObjects(possibleHits, true);

        const finalPos = intersections.length > 0
            ? intersections[0].point.clone().add(cameraDir.multiplyScalar(-0.1))
            : cameraPos;

        camera.position.copy(finalPos);

        const lookTarget = camera.position.clone().add(
            new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(playerPitch, playerYaw, 0, 'YXZ')).multiplyScalar(10)
        );

        camera.lookAt(lookTarget);

        // Hide local model in first-person
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
})();
CameraSystem.initCamera();
// === CameraSystem End ===

// === UISystem Begin ===
const UISystem = (() => {
    const menuEl = document.getElementById('menu');
    const gameEl = document.getElementById('game');
    const infoEl = document.getElementById('info');
    const playerNameInput = document.getElementById('playerName');
    const roomIdInput = document.getElementById('roomId');
    const roomListDiv = document.getElementById('roomList');
    const serverStatusDiv = document.getElementById('server-status');

    let hudSprite;
    let hudScene;
    let crosshair = null;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => {
        gameState = gs;
        UISystem.showGameUI(`Room ID: ${gameState.roomId}`);
    });
    EventBus.on("game:ended", () => {
        showMainMenu();
        gameState.clear();
    });

    EventBus.on("player:healthChanged", ({ playerId, health }) => {
        if (playerId === gameState.playerId) {
            updateHealthHud(health);
        }
    });

    EventBus.on("player:died", ({ playerId, message, position }) => {
        showServerMessage(message);
    });

    EventBus.on("game:message", ({ message }) => {
        showServerMessage(message);
    });

    function init() {
        // Restore name from localStorage
        const saved = localStorage.getItem('playerName');
        if (saved) playerNameInput.value = saved;

        // Create initial HUD
        hudScene = new THREE.Scene();
        createHud();
        createCrosshair();

        document.getElementById("btnCreateRoom").addEventListener("click", async () => {
            const btn = document.getElementById("btnCreateRoom");
            btn.disabled = true;
            try {
                await GameSystem.createRoom();
            }
            catch (err) {
                console.error("Error during createRoom:", err);
            }
            finally {
                btn.disabled = false;
            }
        });

        document.getElementById("btnJoinRoom").addEventListener("click", async () => {
            const btn = document.getElementById("btnJoinRoom");
            btn.disabled = true;
            try {
                await GameSystem.joinRoom();
            }
            catch (err) {
                console.error("Error during joinRoom:", err);
            }
            finally {
                btn.disabled = false;
            }
        });

        document.getElementById("btnLeaveeRoom")
            .addEventListener("click", () => GameSystem.leaveGame());

        document.getElementById('toggleView').addEventListener('click', (e) => {
            e.stopPropagation();
            EventBus.emit("input:toggleView");
        });
    }

    function getHudScene() {
        return hudScene;
    }

    function getCrosshair() {
        return crosshair;
    }

    function createHud() {
        const material = createHudTextCanvas("Health: 0");
        hudSprite = new THREE.Sprite(material);
        hudSprite.scale.set(200, 100, 1);
        hudSprite.position.set(window.innerWidth - 40, window.innerHeight - 50, 0);
        hudScene.add(hudSprite);
    }

    function updateHealthHud(health) {
        const mat = createHudTextCanvas(`Health: ${health}`);
        hudSprite.material.dispose();
        hudSprite.material = mat;
    }

    function showGameUI(message) {
        menuEl.style.display = 'none';
        gameEl.style.display = 'block';
        infoEl.innerText = message;
    }

    function showMainMenu() {
        menuEl.style.display = 'block';
        gameEl.style.display = 'none';
        infoEl.innerText = '';
        roomIdInput.value = '';
    }

    function getPlayerName() {
        return playerNameInput.value.trim();
    }

    function savePlayerName() {
        localStorage.setItem('playerName', getPlayerName());
    }

    function getRoomId() {
        return roomIdInput.value.trim();
    }

    function populateMapList(maps) {
        const selector = document.getElementById('mapSelector');
        selector.innerHTML = '';

        maps.forEach(({ id, name }) => {
            const option = document.createElement('option');
            option.value = id;
            option.innerText = name;
            selector.appendChild(option);
        });
    }

    function getSelectedMap() {
        const selector = document.getElementById('mapSelector');
        return selector.value;
    }

    function renderRoomList(rooms, joinCallback) {
        roomListDiv.innerHTML = '';
        if (!rooms.length) {
            roomListDiv.innerText = 'No active rooms.';
            return;
        }

        rooms.forEach(({ id, count }) => {
            const el = document.createElement('div');
            el.innerText = `${id} (${count} players)`;
            el.onclick = () => joinCallback(id);
            roomListDiv.appendChild(el);
        });
    }

    function createHudTextCanvas(text) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 30;
        canvas.width = 256;
        canvas.height = 128;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillText(text, 10, fontSize);

        const texture = new THREE.CanvasTexture(canvas);
        return new THREE.SpriteMaterial({ map: texture, transparent: true });
    }

    function createCrosshair() {
        const size = 10;
        const material = new THREE.LineBasicMaterial({ color: 0xffffff });
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-size, 0, 0),
            new THREE.Vector3(size, 0, 0),
            new THREE.Vector3(0, -size, 0),
            new THREE.Vector3(0, size, 0),
        ]);

        geometry.setIndex([0, 1, 2, 3]);

        crosshair = new THREE.LineSegments(geometry, material);
        updateCrosshairPosition();
        hudScene.add(crosshair);
    }

    function updateCrosshairPosition() {
        if (crosshair) {
            crosshair.position.set(window.innerWidth / 2, window.innerHeight / 2, 0);
        }
    }

    function showServerMessage(text) {
        const container = document.getElementById('server-messages');
        if (!container) return;

        const el = document.createElement('div');
        el.innerText = text;
        el.style.padding = '5px 10px';
        el.style.marginBottom = '5px';
        el.style.background = 'rgba(0,0,0,0.7)';
        el.style.color = 'white';
        el.style.borderRadius = '4px';
        el.style.fontSize = '14px';

        container.appendChild(el);

        setTimeout(() => {
            el.remove();
        }, 3000);
    }

    return {
        init,
        showGameUI,
        showMainMenu,
        updateHealthHud,
        getPlayerName,
        savePlayerName,
        getRoomId,
        populateMapList,
        getSelectedMap,
        renderRoomList,
        getHudScene,
        getCrosshair,
        updateCrosshairPosition
    };
})();
UISystem.init();
// === UISystem End ===

// === LaserSystem Begin ===
const LaserSystem = (() => {
    const COOLDOWN = 250; // ms between shots
    let lastFired = 0;

    const lasers = [];
    const laserMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    let localLaserIdCounter = 0;
    const pendingLasers = {}; // id -> { object, origin, dir }

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function shoot() {
        if (!gameState.roomId || !gameState.playerObj) return;

        const now = Date.now();
        if (now - lastFired < COOLDOWN) return;
        lastFired = now;

        // 🎯 Aim from camera to crosshair target
        const { point: targetPoint } = CameraSystem.getCrosshairTarget(gameState.octree, 500);

        // 🚀 Fire from player's muzzle toward target
        const forward = new THREE.Vector3();
        CameraSystem.getCamera().getWorldDirection(forward);

        let muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0))     // height offset (head/chest)
            .add(forward.multiplyScalar(5));
        let shootDir = targetPoint.clone().sub(muzzle).normalize();
        const distance = shootDir.length();
        const minDistance = 1.0;

        if (distance < minDistance) {
            // Target too close — using camera direction instead"
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
        }
        else {
            createLaserVisual(from, dir, id);
        }
    }

    function handleBlocked({ id, position }) {
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
        handleBlocked,
    };
})();
// === LaserSystem End ===

// === MachineGunSystem Begin ===
const MachineGunSystem = (() => {
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

        const { origin, direction: cameraDirection, point: targetPoint } = CameraSystem.getCrosshairTarget(gameState.octree, 1000);

        // === compute muzzle & shoot direction ===
        const forward = cameraDirection.clone();

        const muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0))
            .add(forward.clone().multiplyScalar(1.5));

        const shootDir = targetPoint.clone().sub(muzzle).normalize();

        socket.emit('machinegunFire', {
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
        EffectSystem.spawnMuzzleFlash(origin, direction);
        EffectSystem.spawnTracer(origin, direction);

        if (showImpact && targetPoint) {
            EffectSystem.spawnHitEffect(targetPoint, direction.clone().negate());
        }
    }

    return {
        shoot,
        handleBlocked,
        handleHit
    };
})();

// === ShotgunSystem Begin ===
const ShotgunSystem = (() => {
    const COOLDOWN = 800; // milliseconds
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

        const { point: targetPoint } = CameraSystem.getCrosshairTarget(gameState.octree, 30);

        const baseDirection = targetPoint.clone()
            .sub(gameState.playerObj.position)
            .normalize();

        const muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0)) // chest height
            .add(baseDirection.clone().multiplyScalar(1.5));

        // Show one unified muzzle flash
        EffectSystem.spawnMuzzleFlash(muzzle, baseDirection);

        for (let i = 0; i < PELLET_COUNT; i++) {
            const dir = baseDirection.clone();

            // Apply random spread
            const axis = new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize();
            const angle = THREE.MathUtils.degToRad((Math.random() - 0.5) * SPREAD_ANGLE);
            dir.applyAxisAngle(axis, angle).normalize();

            performVisualRay(muzzle, dir, true);
        }

        // Emit and render
        socket.emit('shotgunFire', {
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
                EffectSystem.spawnHitEffect(point, normal);
            }
        }

        EffectSystem.spawnTracer(origin, direction);
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
})();
// === ShotgunSystem End ===

// === RocketSystem Begin ===
const RocketSystem = (() => {
    const COOLDOWN = 1000; // ms between rockets
    let lastFired = 0;

    const rockets = [];
    const rocketMaterial = new THREE.MeshBasicMaterial({ color: 0xff9900 });
    let localRocketIdCounter = 0;
    const pendingRockets = {}; // id -> { object }

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    function shoot() {
        if (!gameState.roomId || !gameState.playerObj) return;

        const now = Date.now();
        if (now - lastFired < COOLDOWN) return;
        lastFired = now;

        const { origin, direction: cameraDirection, point: targetPoint } = CameraSystem.getCrosshairTarget(gameState.octree, 1000);

        // === compute muzzle & shoot direction ===
        const forward = cameraDirection.clone();

        let muzzle = gameState.playerObj.position.clone()
            .add(new THREE.Vector3(0, 0.5, 0))
            .add(forward.clone().multiplyScalar(1.5));

        let shootDir = targetPoint.clone().sub(muzzle).normalize();
        const distance = shootDir.length();
        const minDistance = 1.0;

        if (distance < minDistance) {
            // Target too close — using camera direction instead"
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
        EffectSystem.createRocketExplosion(position);
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
})();
// === RocketSystem End ===

// === WeaponSystem Begin ===
const WeaponSystem = (() => {
    const weapons = {
        laser: LaserSystem,
        machinegun: MachineGunSystem,
        shotgun: ShotgunSystem,
        rocket: RocketSystem
    };

    let fireHeld = false;
    EventBus.on("input:shootBegin", () => {
        shoot();
        fireHeld = true;
    });
    EventBus.on("input:shootEnd", () => fireHeld = false);

    EventBus.on("input:switchWeapon", ({ weaponId }) => {
        if (weaponId === 2) {
            switchWeapon('shotgun');
        }
        else if (weaponId === 3) {
            switchWeapon('machinegun');
        }
        else if (weaponId === 4) {
            switchWeapon('rocket');
        }
        else {
            switchWeapon('laser');
        }
    });

    EventBus.on("input:nextWeapon", () => {
        if (currentWeapon === 'laser') {
            switchWeapon('shotgun');
        }
        else if (currentWeapon === 'shotgun') {
            switchWeapon('machinegun');
        }
        else if (currentWeapon === 'machinegun') {
            switchWeapon('rocket');
        }
        else {
            switchWeapon('laser');
        }
    });

    function handleHit({ shooterId, targetId, position, health, damage }) {
        EventBus.emit("player:healthChanged", { playerId: targetId, health });
        EventBus.emit("player:tookDamage", { position, health, damage });
    }

    let currentWeapon = 'laser';

    function shoot() {
        if (weapons[currentWeapon]) {
            weapons[currentWeapon].shoot();
        }
    }

    function switchWeapon(name) {
        if (weapons[name]) {
            currentWeapon = name;
            EventBus.emit("weapon:switched", { weapon: name });
        }
    }

    function getWeapon() {
        return currentWeapon;
    }

    function update() {
        if (fireHeld) {
            shoot();
        }
    }

    return {
        shoot,
        switchWeapon,
        getWeapon,
        handleHit,
        update
    };
})();
// === WeaponSystem End ===

// === GrappleSystem Begin ===
const GrappleSystem = (() => {

    const MAX_GRAPPLE_DISTANCE = 1000;
    const MAX_GRAPPLE_LAUNCH_SPEED = 75; // clamp speed to avoid crazy launches
    const GRAPPLE_PULL_STRENGTH = 60;

    const state = {
        active: false,
        fired: false,
        attached: false,
        point: null,
        origin: null,
        direction: new THREE.Vector3(),
        currentLength: 0,
        isHanging: false,
        mesh: null, // ✅ Cylinder rope mesh
        wasGrappleAttachedLastFrame: false,
        grappleMomentumActive: false,
        grappleMomentum: new THREE.Vector3(),
        previousGrapplePosition: new THREE.Vector3()
    };

    const ropeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const remoteGrapples = {}; // playerId → { mesh, direction, origin }
    const raycaster = new THREE.Raycaster();

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => { gameState.clear(); });

    EventBus.on("input:fireGrapple", () => { fire(); });
    EventBus.on("input:releaseGrapple", () => { release(); });

    function fire() {
        if (!gameState.roomId || !gameState.playerObj || state.fired) return;

        const { centerDirection, coneTip } = CameraSystem.getAimDirection(gameState.playerObj);

        const { point: targetPoint } = CameraSystem.getCrosshairTarget(gameState.octree, 1000);
        const shootDir = targetPoint.clone().sub(coneTip).normalize();

        state.fired = true;
        state.active = true;
        state.attached = false;
        state.currentLength = 0;
        state.direction = shootDir;
        state.origin = coneTip.clone();
        state.point = null;

        EventBus.emit("player:grappleStarted", { roomId: gameState.roomId, origin: coneTip, direction: centerDirection });
    }

    function updatePhysic(delta, player, playerVelocity, vecMoveDir, moveSpeed, isGrounded) {
        const grappleState = state;
        const grappleNow = grappleState.attached;
        const justReleasedGrapple = !grappleNow && grappleState.wasGrappleAttachedLastFrame;
        const moveDirLenSq = vecMoveDir.lengthSq();

        // Track position during grapple for swing velocity
        if (grappleNow) {
            grappleState.previousGrapplePosition.copy(player.position);
        }

        if (justReleasedGrapple) {
            const currentPos = player.position.clone();
            const swingVelocity = currentPos.clone().sub(grappleState.previousGrapplePosition).divideScalar(delta);

            if (swingVelocity.length() > MAX_GRAPPLE_LAUNCH_SPEED) {
                swingVelocity.setLength(MAX_GRAPPLE_LAUNCH_SPEED);
            }

            grappleState.grappleMomentum.copy(swingVelocity);
            grappleState.grappleMomentumActive = true;
            playerVelocity.copy(swingVelocity);
        }

        if (!grappleNow && grappleState.grappleMomentumActive) {
            const inputSpeed = new THREE.Vector3(0, 0, 0);
            let decayFactor = 0.995;

            if (moveDirLenSq > 0) {
                const moveDir = vecMoveDir.clone().normalize();
                const momentumDir = grappleState.grappleMomentum.clone().normalize();
                const dot = moveDir.dot(momentumDir);

                if (dot < -0.1) {
                    decayFactor = 0.95;
                }

                inputSpeed.copy(moveDir).multiplyScalar(moveSpeed);
            }

            grappleState.grappleMomentum.multiplyScalar(decayFactor);

            if (moveDirLenSq > 0) {
                if (Math.abs(grappleState.grappleMomentum.x) < Math.abs(inputSpeed.x)) {
                    grappleState.grappleMomentum.x = inputSpeed.x;
                }
                if (Math.abs(grappleState.grappleMomentum.z) < Math.abs(inputSpeed.z)) {
                    grappleState.grappleMomentum.z = inputSpeed.z;
                }
            }

            playerVelocity.x = grappleState.grappleMomentum.x;
            playerVelocity.z = grappleState.grappleMomentum.z;

            if (grappleState.grappleMomentum.lengthSq() < 0.01) {
                grappleState.grappleMomentumActive = false;
            }
        }
        else if (!grappleNow && moveDirLenSq > 0) {
            playerVelocity.x = vecMoveDir.x * moveSpeed;
            playerVelocity.z = vecMoveDir.z * moveSpeed;
        }
        else if (!grappleNow && isGrounded) {
            playerVelocity.x *= 0.8;
            playerVelocity.z *= 0.8;
        }

        // prevent residual movements
        if (isGrounded && moveDirLenSq < 0.01) {
            playerVelocity.set(0, playerVelocity.y, 0); // keep Y for gravity
            grappleState.grappleMomentum.set(0, 0, 0);
            grappleState.grappleMomentumActive = false;
        }

        grappleState.wasGrappleAttachedLastFrame = grappleNow;
    }

    function release() {
        if (!state.active) return;

        state.active = false;
        state.fired = false;
        state.attached = false;
        state.point = null;
        state.origin = null;

        if (state.mesh) {
            scene.remove(state.mesh);
            state.mesh.geometry.dispose();
            state.mesh.material.dispose();
            state.mesh = null;
        }

        EventBus.emit("player:grappleEnded", { roomId: gameState.roomId });
    }

    function update(delta, velocity, octree) {
        if (!state.active) {
            OctreeClearDebugWires(scene, 2);
            return
        };

        const playerObj = gameState.playerObj;
        if (!playerObj) return;

        if (state.fired && !state.attached) {
            state.currentLength += delta * 80;
            state.currentLength = Math.min(state.currentLength, MAX_GRAPPLE_DISTANCE);

            // Use octree to find nearby objects along the ray
            const possibleHits = octree.queryRay(
                state.origin,
                state.direction,
                state.currentLength
            );

            OctreeDrawQueriedObjects(possibleHits, scene, 2, 0x0000ff);

            raycaster.set(state.origin.clone(), state.direction.clone());
            raycaster.far = state.currentLength;

            const hits = raycaster.intersectObjects(possibleHits, true);

            if (hits.length > 0) {
                state.point = hits[0].point.clone();
                state.attached = true;
            }
        }

        if (state.attached && state.point) {

            const toGrapple = state.point.clone().sub(playerObj.position);
            const distance = toGrapple.length();

            if (distance > 1) {
                const pullDir = toGrapple.clone().normalize();
                const pullStrength = delta * GRAPPLE_PULL_STRENGTH;

                velocity.addScaledVector(pullDir, pullStrength);
                state.isHanging = false;
            }
            else {
                const fallingOrMoving = velocity.y <= 0;
                const tryingToJump = InputSystem.isJumpBuffered();

                if (tryingToJump && fallingOrMoving) {
                    // Allow jump boost; preserve velocity
                    // Let PlayerSystem handle the upward push
                }
                else {
                    velocity.set(0, 0, 0); // You're just hanging, not jumping
                }

                state.isHanging = true;
            }
        }

        updateRopeVisual(playerObj);
    }

    function getCurrentTipPosition() {
        if (state.attached && state.point) return state.point.clone();
        return state.origin.clone().addScaledVector(state.direction, state.currentLength);
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
        for (const [pid, g] of Object.entries(remoteGrapples)) {
            if (!g.playerObj) continue;

            g.distance += delta * 80;
            const tip = g.origin.clone().addScaledVector(g.direction, g.distance);
            const playerPos = g.playerObj.position.clone().add(new THREE.Vector3(0, 0.5, 0));
            const material = new THREE.MeshBasicMaterial({ color: 0x00ffff });

            g.mesh = createOrUpdateRopeCylinder(g.mesh, playerPos, tip, material);
        }
    }

    function createOrUpdateRopeCylinder(mesh, start, end, material) {
        const dir = new THREE.Vector3().subVectors(end, start);
        const length = dir.length();
        const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

        if (!mesh) {
            const geometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8, 1, true);
            mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);
        } else {
            scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();

            const geometry = new THREE.CylinderGeometry(0.02, 0.02, length, 8, 1, true);
            mesh.geometry = geometry;
            mesh.material = material;
            scene.add(mesh);
        }

        mesh.position.copy(midpoint);
        mesh.lookAt(end);
        mesh.rotateX(Math.PI / 2);

        return mesh;
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
})();
// === GrappleSystem End ===

// === PlayerSystem Begin ===
const PlayerSystem = (() => {
    const GRAVITY = -20.8;
    const GRAVITY_TERMINAL_VELOCITY = -150;
    const JUMP_SPEED = 12;
    const MOVE_SPEED = 7;
    const DEBUG_ARROW_SCALE = 2.0;
    const PLAYER_HEIGHT = 1.0;
    const GROUND_RAY_OFFSET = 0.09;
    const PLAYER_HALF_HEIGHT = 0.5;
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

    function update(delta, octree) {
        const player = gameState.playerObj;
        if (!player) return;

        const speed = velocity.length();
        const moveDistance = speed * delta;
        let maxStepDistance = gameState.requiresPrecisePhysics ? 0.02 : 0.1;

        const steps = Math.ceil(moveDistance / maxStepDistance);
        const clampedSteps = Math.min(Math.max(steps, 1), 50);
        const subDelta = delta / clampedSteps;

        const startPhysic = performance.now();
        for (let i = 0; i < clampedSteps; i++) {
            const start = performance.now();

            updatePhysicsStep(subDelta, octree);

            const end = performance.now();
            if (end - start > 5) {
                console.warn(`UpdatePhysicsStep (step ${i + 1}/${clampedSteps}): ${(end - start).toFixed(2)} ms`);
            }
        }
        const endPhysic = performance.now();
        if (endPhysic - startPhysic > 10) {
            console.warn(`UpdatePhysics: ${(endPhysic - startPhysic).toFixed(2)} ms`);
        }
    }

    function updatePhysicsStep(delta, octree) {
        const player = gameState.playerObj;
        if (!player) return;

        if (window.debug === true) {
            scene.children = scene.children.filter(obj => !(obj instanceof THREE.ArrowHelper));
        }

        const keyState = InputSystem.getKeyState();
        const { playerYaw } = InputSystem.getLookAngles();
        player.rotation.y = playerYaw;

        // 1. Apply gravity
        applyGravity(delta);

        // 2. Handle jump input
        handleJump();

        // 3. Compute movement direction
        let moveDir = computeMovementDirection(player.rotation, keyState);

        // 4. Grapple momentum handling
        GrappleSystem.updatePhysic(delta, player, velocity, moveDir, MOVE_SPEED, isGrounded);

        // 5. Collision-aware movement
        performIntegratedMovement(player, delta, octree);

        // 6. Ground detection
        checkGroundCollision(octree, player);

        // 7. Emit movement events
        const isIdle =
            isGrounded &&
            moveDir.lengthSq() === 0 &&
            Math.abs(velocity.x) < 0.1 &&
            Math.abs(velocity.z) < 0.1;

        emitMovementEvents(player, isIdle);
    }

    function applyGravity(delta) {
        if (!GrappleSystem.state.attached && !isGrounded) {
            velocity.y += GRAVITY * delta;
            velocity.y = Math.max(velocity.y, GRAVITY_TERMINAL_VELOCITY);
        }
    }

    function handleJump() {
        if (isGrounded && InputSystem.isJumpBuffered()) {
            velocity.y = JUMP_SPEED;
            isGrounded = false;
            InputSystem.clearJumpBuffer();
        }
        else if (!InputSystem.isJumpBuffered()) {
            InputSystem.clearJumpBuffer();
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

            const tCapsule = performance.now();
            const capsule = getPlayerCapsule(me);
            const nearby = octree.queryCapsule(capsule);
            const tQuery = performance.now();

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
                        if (GrappleSystem?.state?.grappleMomentum) {
                            GrappleSystem.state.grappleMomentum.y = 0;
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

    function emitMovementEvents(me, isIdle) {
        EventBus.emit("player:moved", {
            roomId: gameState.roomId,
            position: me.position,
            yaw: me.rotation.y,
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

    const _capsuleStart = new THREE.Vector3();
    const _capsuleEnd = new THREE.Vector3();

    function getPlayerCapsule(player) {
        const radius = player.userData.capsule?.radius || PLAYER_CAPSULE_RADIUS;
        const height = player.userData.capsule?.height || PLAYER_CAPSULE_HEIGHT;

        const centerY = player.position.y;
        const centerX = player.position.x;
        const centerZ = player.position.z;

        _capsuleStart.set(centerX, centerY - height / 2 + radius, centerZ);
        _capsuleEnd.set(centerX, centerY + height / 2 - radius, centerZ);

        return {
            start: _capsuleStart,
            end: _capsuleEnd,
            radius,
            height,
        };
    }

    function getVelocity() {
        return velocity;
    }

    EventBus.on("player:respawned", ({ playerId, position, health }) => {
        if (playerId === gameState.playerId) {
            velocity.x = 0;
            velocity.y = 0;
            velocity.z = 0;
            EventBus.emit("player:healthChanged", { playerId, health });
        }
    });

    EventBus.on("player:healthChanged", ({ playerId, health }) => {
        if (playerId === gameState.playerId) {
            setLocalHealth(health);
        }
    });

    EventBus.on("player:rocketExplosion", ({ playerId, position }) => {
        if (playerId !== gameState.playerId) {
            return;
        }

        const playerPos = gameState.playerObj.position;
        const explosionPos = new THREE.Vector3(position.x, position.y, position.z);
        const knockbackDir = playerPos.clone().sub(explosionPos).normalize();

        const distance = playerPos.distanceTo(explosionPos);
        const maxDistance = 6; // beyond this, no knockback

        if (distance > maxDistance) return;

        // Scale strength: closer = stronger knockback
        const strengthFactor = 1 - distance / maxDistance;
        const knockbackStrength = 15 * strengthFactor; // tweak multiplier as needed

        velocity.x += knockbackDir.x * knockbackStrength;
        velocity.y += knockbackDir.y * knockbackStrength + 2; // lift the player a bit
        velocity.z += knockbackDir.z * knockbackStrength;
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
})();
// === PlayerSystem End ===

// === MapSystem Begin ===
const MapSystem = createMapSystem({ scene });
// === MapSystem End ===

// === SkySystem Begin ===
const SkySystem = (() => {
    let moon, sky, skyUniforms, stars;
    let skyTime = 0;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => {
        gameState = gs;
        init();
    });
    EventBus.on("game:ended", clear);

    function init() {
        // Sky
        sky = new Sky();
        sky.scale.setScalar(10000);
        scene.add(sky);

        // Moon
        moon = new THREE.Mesh(
            new THREE.SphereGeometry(3, 16, 16),
            new THREE.MeshBasicMaterial({
                color: 0xddddff,
                transparent: true,
                opacity: 0
            })
        );
        moon.scale.setScalar(60);
        moon.frustumCulled = false;
        scene.add(moon);

        // Sky shader uniforms
        skyUniforms = sky.material.uniforms;
        Object.assign(skyUniforms, {
            turbidity: { value: 10 },
            rayleigh: { value: 2 },
            mieCoefficient: { value: 0.0005 },
            mieDirectionalG: { value: 0.6 },
        });

        createStars();
    }

    function createStars() {
        const starCount = 1000;
        const radius = 2000;
        const positions = [];

        for (let i = 0; i < starCount; i++) {
            const theta = Math.random() * 2 * Math.PI;
            const phi = Math.acos(2 * Math.random() - 1);
            const x = radius * Math.sin(phi) * Math.cos(theta);
            const y = radius * Math.sin(phi) * Math.sin(theta);
            const z = radius * Math.cos(phi);
            positions.push(x, y, z);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        const material = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 1.5,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0,
            depthWrite: false
        });

        stars = new THREE.Points(geometry, material);
        stars.name = 'stars';
        scene.add(stars);
    }

    function clear() {
        [sky, moon, stars].forEach(obj => {
            if (!obj) return;
            scene.remove(obj);
            obj.geometry?.dispose();
            obj.material?.dispose();
        });

        sky = moon = stars = skyUniforms = null;
        skyTime = 0;
    }

    function update(delta) {
        if (!gameState.playerObj) return;

        const now = Date.now();
        const secondsUTC = (now % 86400000) / 1000; // seconds since midnight UTC
        const skyTime = secondsUTC;

        const playerPos = gameState.playerObj.position;
        const angle = skyTime * 0.02;

        // Position moon behind player at far distance
        const radius = 3000;
        const moonOffset = new THREE.Vector3(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
            0
        );
        moon.position.copy(playerPos).add(moonOffset).addScalar(1000);
        moon.lookAt(playerPos);

        // Fade (can be improved to actually reflect sun's position if needed)
        const fade = 1;
        if (stars) stars.material.opacity = fade * 1.5;
        moon.material.opacity = fade * 1.5;

        skyUniforms['rayleigh'].value = 2 - fade * 1.8;
    }

    return { update };
})();
// === SkySystem End ===

// === Debug Begin ===
const urlParams = new URLSearchParams(window.location.search);
window.debug = urlParams.get('debug') === 'true';
if (window.debug) {
    console.warn("[DEBUG] Activated.");
}
function OctreeClearDebugWires(scene, debugId) {
    if (window.debug !== true) {
        return;
    }
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.userData?.debugId != null && obj.userData?.debugId === debugId) {
            scene.remove(obj);
        }
    }
}

function OctreeDrawQueriedObjects(objects, scene, debugId, color = 0x00ff00) {
    if (window.debug !== true) {
        return;
    }
    OctreeClearDebugWires(scene, debugId);

    for (const obj of objects) {
        const box = obj.userData?.box;
        if (!box) continue;

        const size = {
            x: box.max.x - box.min.x,
            y: box.max.y - box.min.y,
            z: box.max.z - box.min.z
        };
        const center = {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2
        };

        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(geometry);
        const wire = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({ color })
        );
        wire.position.set(center.x, center.y, center.z);
        wire.userData.debugId = debugId; // tag for cleanup
        scene.add(wire);
    }
}

function OctreeDrawAABB(node, scene, debugId) {
    if (window.debug !== true) {
        return;
    }

    // Draw node boundary in white
    const boxSize = node.size;
    const half = boxSize / 2;
    const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
    const edges = new THREE.EdgesGeometry(geometry);
    const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffffff })
    );
    line.position.set(node.center.x, node.center.y, node.center.z);
    line.userData.debugId = debugId;
    scene.add(line);

    // Draw red AABBs for each object in this node
    for (const obj of node.objects) {
        const size = obj.size;
        const center = obj.center;

        // Draw box using size + center (world-aligned)
        const geom = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const edge = new THREE.EdgesGeometry(geom);
        const line = new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0xff0000 }));
        line.position.copy(center);
        scene.add(line);
    }

    // Recurse into children
    if (node.children) {
        for (const child of node.children) {
            OctreeDrawAABB(child, scene, debugId);
        }
    }
}
// === Debug End ===

// === NetworkSystem Begin ===
const NetworkSystem = (() => {
    let lastHeartbeat = 0;
    let lastServerResponse = 0;

    function init() {
        socket.on("connect", onConnect);
        socket.on("playerList", handlePlayerList);
        socket.on("playerMoved", handlePlayerMoved);
        socket.on("playerDisconnected", handlePlayerDisconnected);

        socket.on("loadMap", MapSystem.loadMap);
        socket.on("laserHit", WeaponSystem.handleHit);
        socket.on("laserFired", LaserSystem.handleFired);
        socket.on("laserBlocked", LaserSystem.handleBlocked);

        socket.on("machinegunBlocked", MachineGunSystem.handleBlocked);
        socket.on("machinegunHit", MachineGunSystem.handleHit);

        socket.on("shotgunBlocked", ShotgunSystem.handleBlocked);
        socket.on("shotgunHit", ShotgunSystem.handleHit);

        socket.on("rocketHit", RocketSystem.handleHit);
        socket.on("rocketLaunched", RocketSystem.handleLaunched);
        socket.on("rocketExploded", RocketSystem.handleExploded);

        socket.on("healthPackTaken", MapSystem.healthPackTaken);
        socket.on("healthPackRespawned", MapSystem.healthPackRespawned);

        socket.on("remoteGrappleStart", ({ playerId, origin, direction }) => {
            const playerObj = GameSystem.getPlayer(playerId);
            GrappleSystem.remoteGrappleStart({ playerId, origin, direction, playerObj });
        });
        socket.on("remoteGrappleEnd", GrappleSystem.remoteGrappleEnd);

        socket.on("respawn", handleRespawn);
        socket.on("playerDied", handlePlayerDied);
        socket.on("serverMessage", handleServerMessage);
        socket.on("heartbeatAck", handleHeartbeatAck);

        // Start heartbeat loop
        lastServerResponse = Date.now(); // ← initialize as alive now
        lastHeartbeat = Date.now();
        setInterval(sendHeartbeatIfNeeded, 7500);
    }

    function onConnect() {
        refreshRoomList();

        // Load maps on connect
        socket.emit('getMaps', (maps) => {
            UISystem.populateMapList(maps);
        })

        setInterval(refreshRoomList, 10000);
    }

    function handlePlayerList(list) {
        for (const id in list) {
            if (!GameSystem.getPlayer(id) && PlayerSystem.getLocalPlayerId() !== id) {
                const { name, position, health, modelName } = list[id];
                GameSystem.addPlayer(id, position.x, position.y, position.z, name, modelName);
            }
        }
    }

    function handlePlayerMoved({ id, position, rotation, isIdle, isGrounded }) {
        const player = GameSystem.getPlayer(id);
        if (player) {
            player.position.set(position.x, position.y, position.z);
            if (rotation) {
                player.rotation.y = rotation.y;
            }
        }

        EventBus.emit("player:animated", {
            playerId: id,
            isGrounded: isGrounded,
            isIdle: isIdle
        });
    }

    function handlePlayerDisconnected(id) {
        if (PlayerSystem.getLocalPlayerId() === id) {
            alert("Disconnected");
            GameSystem.leaveGame();
        }
        else {
            GameSystem.removePlayer(id);
        }
    }

    function handleRespawn({ playerId, position, health }) {
        const player = GameSystem.getPlayer(playerId);
        if (!player) return;

        player.visible = true;
        player.position.set(position.x, position.y, position.z);

        EventBus.emit("player:respawned", { playerId, position, health });
    }

    function handlePlayerDied({ playerId, position, message }) {
        const player = GameSystem.getPlayer(playerId);
        if (player) {
            player.visible = false; // Make the player invisible on death
        }

        EventBus.emit("player:died", { playerId, message, position });
    }

    function handleServerMessage({ message }) {
        EventBus.emit("game:message", { message });
    }

    function refreshRoomList() {
        socket.emit("getRooms", (rooms) => {
            UISystem.renderRoomList(rooms, GameSystem.joinRoom);
        });
    }

    function sendHeartbeat() {
        socket.emit("heartbeat");
    }

    function sendHeartbeatIfNeeded() {
        const now = Date.now();

        // If no ack in over 60 seconds, assume server is unresponsive
        if (now - lastServerResponse > 60000) {
            console.warn("No heartbeatAck from server in 60 seconds. Leaving game.");
            GameSystem.leaveGame();
            return;
        }

        // Send a heartbeat if it's time
        if (now - lastHeartbeat > 5000) {
            sendHeartbeat();
            lastHeartbeat = now;
        }
    }

    function handleHeartbeatAck() {
        lastServerResponse = Date.now();
    }

    EventBus.on("player:moved", ({ roomId, position, yaw, playerId, isGrounded, isIdle }) => {
        socket.emit("move", {
            roomId: roomId,
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: 0, y: yaw, z: 0 },
            isIdle: isIdle,
            isGrounded: isGrounded
        });
    });

    EventBus.on("player:shot", ({ roomId, origin, direction, laserId }) => {
        socket.emit('shoot', {
            roomId: roomId,
            origin: origin,
            direction: direction,
            id: laserId
        });
    });

    EventBus.on("player:launchRocket", ({ roomId, origin, direction, rocketId }) => {
        socket.emit('launchRocket', {
            roomId: roomId,
            origin: origin,
            direction: direction,
            id: rocketId
        });
    });

    EventBus.on("player:grappleStarted", ({ roomId, origin, direction }) => {
        socket.emit('grappleStart', {
            roomId: roomId,
            origin: origin,
            direction: direction
        });
    });

    EventBus.on("player:grappleEnded", ({ roomId }) => {
        socket.emit('grappleEnd', { roomId });
    });

    return {
        init
    };
})();
NetworkSystem.init();
// === NetworkSystem End ===

// === GameSystem Begin ===
const GameSystem = (() => {
    let gameStarted = false;
    let roomId = null;
    const players = {};

    async function createRoom() {
        const playerName = UISystem.getPlayerName();
        if (!playerName) {
            alert("Enter a name");
            throw new Error("Missing player name");
        }

        const mapName = UISystem.getSelectedMap();
        UISystem.savePlayerName();

        const index = Math.floor(Math.random() * 3) + 1;
        const modelName = `Astronaut${index}.glb`;

        // Wait for connection if needed
        if (socket.disconnected) {
            await new Promise(resolve => {
                socket.once('connect', resolve);
                socket.connect();
            });
        }

        const { roomId: id, health } = await new Promise((resolve) => {
            socket.emit('createRoom', { name: playerName, modelName, mapName }, resolve);
        });

        roomId = id;
        const pid = socket.id;
        PlayerSystem.setLocalPlayer(pid, playerName, health);

        await new Promise((resolve) => {
            const waitForMap = setInterval(() => {
                if (MapSystem.isLoaded()) {
                    clearInterval(waitForMap);
                    resolve();
                }
            }, 50);
        });

        const playerObj = addPlayer(pid, 0, 0, 0, playerName, modelName);
        gameStarted = true;

        const gameState = new GameState({
            roomId, playerId: pid, playerObj,
            octree: MapSystem.getOctree(), players: players, requiresPrecisePhysics: MapSystem.isRequiringPrecisePhysics()
        });
        EventBus.emit("game:started", gameState);
        EventBus.emit("player:healthChanged", { playerId: pid, health });
    }

    async function joinRoom(idOverride = null) {
        const playerName = UISystem.getPlayerName();
        const joinId = idOverride || UISystem.getRoomId();

        if (!playerName || !joinId) {
            alert("Enter name and room ID");
            throw new Error("Missing player name or room ID");
        }

        UISystem.savePlayerName();
        const index = Math.floor(Math.random() * 3) + 1;
        const modelName = `Astronaut${index}.glb`;

        const { success, error, health } = await new Promise((resolve) => {
            socket.emit('joinRoom', { roomId: joinId, name: playerName, modelName }, resolve);
        });

        if (error) {
            alert(error);
            throw new Error(error);
        }

        roomId = joinId;
        const pid = socket.id;
        PlayerSystem.setLocalPlayer(pid, playerName, health);

        await new Promise((resolve) => {
            const waitForMap = setInterval(() => {
                if (MapSystem.isLoaded()) {
                    clearInterval(waitForMap);
                    resolve();
                }
            }, 50);
        });

        const playerObj = addPlayer(pid, 0, 0, 0, playerName, modelName);
        gameStarted = true;

        const gameState = new GameState({
            roomId, playerId: pid, playerObj,
            octree: MapSystem.getOctree(), players: players, requiresPrecisePhysics: MapSystem.isRequiringPrecisePhysics()
        });
        EventBus.emit("game:started", gameState);
        EventBus.emit("player:healthChanged", { playerId: pid, health });
    }

    function leaveGame() {
        for (const id in players) {
            scene.remove(players[id]);
        }
        Object.keys(players).forEach(id => delete players[id]);

        gameStarted = false;
        roomId = null;

        EventBus.emit("game:ended");

        socket.disconnect();

        setTimeout(() => window.location.reload(), 500);
    }

    function addPlayer(id, x, y, z, name, modelName) {
        const group = new THREE.Group();
        group.position.set(x, y, z);
        group.name = name;

        const capsuleHeight = PLAYER_CAPSULE_HEIGHT;
        const capsuleRadius = PLAYER_CAPSULE_RADIUS;

        group.userData.capsule = { radius: capsuleRadius, height: capsuleHeight };

        // === Load visual model ===
        const modelUrl = `https://www.dailysummary.io/models/${modelName}`;
        const loader = new GLTFLoader();

        loader.load(modelUrl, (gltf) => {
            const model = gltf.scene;

            model.position.set(0, -0.5, 0); // local to group
            model.rotation.y = Math.PI;
            model.scale.set(0.7, 0.7, 0.7); // optional: scale to match capsule

            model.traverse(child => {
                if (child.isSkinnedMesh) {
                    child.frustumCulled = false;
                }
            });

            const mixer = new THREE.AnimationMixer(model);
            group.userData.mixer = mixer;
            group.userData.actions = {};

            for (const clip of gltf.animations) {
                const cleaned = clip.clone();
                cleaned.tracks = cleaned.tracks.filter(track => !track.name.includes('position'));
                const action = mixer.clipAction(cleaned);
                group.userData.actions[clip.name.toLowerCase()] = action;
            }
            playAnimation(group, 'idle');

            group.add(model); // attach to capsule group
        });

        // === Add name tag (unchanged) ===
        if (id !== PlayerSystem.getLocalPlayerId()) {
            const nameTag = createNameTag(name);
            nameTag.position.set(0, capsuleHeight + 0.5, 0);
            group.add(nameTag);
            group.userData.nameTag = nameTag;
        }

        scene.add(group);
        players[id] = group;
        return group;
    }

    function createNameTag(name) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 48;
        canvas.width = 512;
        canvas.height = 128;

        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';

        // Add black stroke for contrast
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.strokeText(name, canvas.width / 2, fontSize);

        // Fill with white text
        ctx.fillStyle = 'white';
        ctx.fillText(name, canvas.width / 2, fontSize);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter; // Optional: improves sharpness
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(2, 0.5, 1); // Adjust to fit name length

        return sprite;
    }

    EventBus.on("player:animated", ({ playerId, isGrounded, isIdle }) => {
        const player = players[playerId];
        if (player != null) {
            if (isIdle) {
                playAnimation(player, 'idle');
            }
            else if (isGrounded === false) {
                playAnimation(player, 'jump_idle');
            }
            else {
                playAnimation(player, 'run');
            }
        }
    });

    function playAnimation(playerModel, animationName) {
        if (playerModel?.userData?.actions == null) {
            return;
        }
        const clipKey = Object.keys(playerModel.userData.actions).find(k => k.includes('|' + animationName));
        if (clipKey) {
            const prevClipKey = playerModel.userData.currentAction;
            if (prevClipKey !== clipKey) {
                if (prevClipKey != null) {
                    const prevAction = playerModel.userData.actions[prevClipKey];
                    prevAction.stop();
                }
                const action = playerModel.userData.actions[clipKey];
                action.play();
                playerModel.userData.currentAction = clipKey;
            }
        }
    }

    function removePlayer(id) {
        if (players[id]) {
            scene.remove(players[id]);
            delete players[id];
        }
    }

    function getPlayer(id) {
        return players[id];
    }

    function isGameStarted() {
        return gameStarted;
    }

    function getRoomId() {
        return roomId;
    }

    function update(delta) {
        // Make all name tags face the camera
        for (const id in players) {
            const player = players[id];
            if (player && player.userData.nameTag) {
                player.userData.nameTag.lookAt(CameraSystem.getCamera().position);
            }
            const mixer = player?.userData?.mixer;
            if (mixer) mixer.update(delta);
        }
    }

    return {
        createRoom,
        joinRoom,
        leaveGame,
        addPlayer,
        removePlayer,
        getPlayer,
        isGameStarted,
        getRoomId,
        update
    };
})();
// === GameSystem End ===

const animate = () => {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    const speed = 5;

    const playerId = PlayerSystem.getLocalPlayerId();
    const me = GameSystem.getPlayer(playerId);
    if (!me || !MapSystem.isLoaded()) {
        renderer.render(scene, CameraSystem.getCamera());
        return;
    };

    const octree = MapSystem.getOctree();

    GrappleSystem.update(delta, PlayerSystem.getVelocity(), octree);

    PlayerSystem.update(delta, octree);

    WeaponSystem.update();

    CameraSystem.update(octree);

    LaserSystem.update(delta);

    RocketSystem.update(delta);

    MapSystem.update(delta);

    SkySystem.update(delta);

    GrappleSystem.updateRemoteGrapples(delta);

    EffectSystem.update(delta);

    GameSystem.update(delta);

    // Render
    const start = performance.now();
    renderer.render(scene, CameraSystem.getCamera());
    if (GameSystem.isGameStarted()) {
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(UISystem.getHudScene(), CameraSystem.getHudCamera());
        renderer.autoClear = true;
    }

    if (window.debug) {
        if (window.octreeDrawn !== true) {

            window.octreeDrawnCount = window.octreeDrawnCount == null ? 0 : window.octreeDrawnCount + 1;
            if (window.octreeDrawnCount > 100) {

                OctreeClearDebugWires(scene, 3);
                OctreeDrawAABB(octree, scene, 3);
                window.octreeDrawn = true;
            }
        }
    }
    const end = performance.now();
    if (end - start > 10) {
        console.warn(`Rendering took ${(end - start).toFixed(2)} ms`);
    }
};

animate();