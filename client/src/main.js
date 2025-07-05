import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { EventBus, GameState, createMapSystem } from 'shared';

import { OctreeClearDebugWires, OctreeDrawQueriedObjects, OctreeDrawAABB } from './debug-utils.js';

import { createLaserSystem } from './systems/laser-system.js';
import { createMachineGunSystem } from './systems/machinegun-system.js';
import { createShotgunSystem } from './systems/shotgun-system.js';
import { createRocketSystem } from './systems/rocket-system.js';
import { createWeaponSystem } from './systems/weapon-system.js';
import { createEffectSystem } from './systems/effect-system.js';
import { createCameraSystem } from './systems/camera-system.js';
import { createSkySystem } from './systems/sky-system.js';
import { createInputSystem } from './systems/input-system.js';
import { createGrappleSystem } from './systems/grapple-system.js';
import { createPlayerSystem } from './systems/player-system.js';
import { createUISystem } from './systems/ui-system.js';

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

const PLAYER_CAPSULE_RADIUS = 0.3;
const PLAYER_CAPSULE_HEIGHT = 1.2;

// === UISystem ===
const UISystem = createUISystem({
    document,
    playerNameInput: document.getElementById('playerName'),
    roomIdInput: document.getElementById('roomId'),
    roomListDiv: document.getElementById('roomList'),
    menuEl: document.getElementById('menu'),
    gameEl: document.getElementById('game'),
    infoEl: document.getElementById('info'),
    btnCreateRoom: document.getElementById('btnCreateRoom'),
    btnJoinRoom: document.getElementById('btnJoinRoom'),
    btnLeaveRoom: document.getElementById('btnLeaveRoom'),
    toggleViewBtn: document.getElementById('toggleView'),
    serverMessageContainer: document.getElementById('server-messages'),
    mapSelector: document.getElementById('mapSelector')
});
UISystem.init();

// === MapSystem ===
const MapSystem = createMapSystem({ scene });

// === EffectSystem ===
const EffectSystem = createEffectSystem({ scene });

// === SkySystem ===
const SkySystem = createSkySystem({ scene });

// === InputSystem ===
const InputSystem = createInputSystem({
    document,
    window,
    navigator,
    btnJump: document.getElementById('btn-jump'),
    btnFire: document.getElementById('btn-fire'),
    btnGrapple: document.getElementById('btn-grapple'),
    btnSwitch: document.getElementById('btn-switch'),
    touchWheel: document.getElementById('touch-wheel'),
});
InputSystem.setup();
InputSystem.setupLookControls();

// === CameraSystem ===
const CameraSystem = createCameraSystem({ scene, inputSystem: InputSystem });
CameraSystem.initCamera();
window.addEventListener('resize', () => {
    CameraSystem.getCamera().aspect = window.innerWidth / window.innerHeight;
    CameraSystem.getCamera().updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    CameraSystem.getHudCamera().right = window.innerWidth;
    CameraSystem.getHudCamera().top = window.innerHeight;
    CameraSystem.getHudCamera().updateProjectionMatrix();
    UISystem.updateCrosshairPosition();
});

// === WeaponSystem ===
const LaserSystem = createLaserSystem({ scene, cameraSystem: CameraSystem });
const MachineGunSystem = createMachineGunSystem({ cameraSystem: CameraSystem, effectSystem: EffectSystem });
const ShotgunSystem = createShotgunSystem({ cameraSystem: CameraSystem, effectSystem: EffectSystem });
const RocketSystem = createRocketSystem({ scene, cameraSystem: CameraSystem, effectSystem: EffectSystem });
const WeaponSystem = createWeaponSystem({ laser: LaserSystem, machinegun: MachineGunSystem, shotgun: ShotgunSystem, rocket: RocketSystem });

// === GrappleSystem ===
const GrappleSystem = createGrappleSystem({ scene, cameraSystem: CameraSystem, inputSystem: InputSystem });

// === PlayerSystem ===
const PlayerSystem = createPlayerSystem({ inputSystem: InputSystem, grappleSystem: GrappleSystem, PLAYER_CAPSULE_RADIUS, PLAYER_CAPSULE_HEIGHT })

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

    EventBus.on("player:machinegunFire", ({ roomId, origin, direction }) => {
        socket.emit('machinegunFire', {
            roomId: roomId,
            origin: origin,
            direction: direction
        });
    });

    EventBus.on("player:shotgunFire", ({ roomId, origin, direction }) => {
        socket.emit('shotgunFire', {
            roomId: roomId,
            origin: origin,
            direction: direction
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

    EventBus.on("ui:createRoom", async ({ onComplete }) => {
        try {
            await createRoom();
        } catch (err) {
            console.error("Create room failed", err);
        } finally {
            onComplete?.();
        }
    });

    EventBus.on("ui:joinRoom", async ({ onComplete }) => {
        try {
            await joinRoom();
        } catch (err) {
            console.error("Join room failed", err);
        } finally {
            onComplete?.();
        }
    });

    EventBus.on("ui:leaveRoom", () => {
        leaveGame();
    });

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