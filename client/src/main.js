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
    let lobbySocket = null;
    let gameSocket = null;

    let lastHeartbeat = 0;
    let lastServerResponse = 0;

    function init() {
        lobbySocket = io(import.meta.env.VITE_SOCKET_URL);

        lobbySocket.on("connect", onLobbyConnect);
        setInterval(sendHeartbeatIfNeeded, 7500);
    }

    function onLobbyConnect() {
        lobbySocket.emit("getMaps", (maps) => {
            UISystem.populateMapList(maps);
        });

        setInterval(refreshRoomList, 10000);
        refreshRoomList();
    }

    function refreshRoomList() {
        if (lobbySocket?.connected) {
            lobbySocket.emit("getRooms", (rooms) => {
                UISystem.renderRoomList(rooms, GameSystem.joinRoom);
            });
        }
    }

    async function connectToGameSocket(roomUrl, roomId, playerName, modelName, health, mapName) {
        if (gameSocket) {
            gameSocket.disconnect();
            gameSocket = null;
        }

        return new Promise((resolve, reject) => {
            gameSocket = io(roomUrl, {
                query: { roomId, name: playerName, modelName, mapName },
                timeout: 120000, // wait up to 120 seconds for connection
                transports: ['websocket'],
                reconnectionAttempts: 3,
                reconnectionDelay: 5000
            });

            gameSocket.on("connect", () => {
                PlayerSystem.setLocalPlayer(gameSocket.id, playerName, health);
                setupGameSocketListeners();
                lastHeartbeat = Date.now();
                lastServerResponse = Date.now();
                resolve();
            });

            gameSocket.on("connect_error", (err) => {
                console.error("Connection error:", err.message);
                reject(err);
            });
        });
    }

    function setupGameSocketListeners() {
        gameSocket.on("playerList", handlePlayerList);
        gameSocket.on("playerMoved", handlePlayerMoved);
        gameSocket.on("playerDisconnected", handlePlayerDisconnected);
        gameSocket.on("loadMap", async (map) => {
            await MapSystem.loadMap(map);
            EventBus.emit("map:loaded");
        });

        gameSocket.on("laserFired", LaserSystem.handleFired);
        gameSocket.on("laserHit", WeaponSystem.handleHit);
        gameSocket.on("laserBlocked", LaserSystem.handleBlocked);
        gameSocket.on("machinegunBlocked", MachineGunSystem.handleBlocked);
        gameSocket.on("machinegunHit", MachineGunSystem.handleHit);
        gameSocket.on("shotgunBlocked", ShotgunSystem.handleBlocked);
        gameSocket.on("shotgunHit", ShotgunSystem.handleHit);
        gameSocket.on("rocketHit", RocketSystem.handleHit);
        gameSocket.on("rocketLaunched", RocketSystem.handleLaunched);
        gameSocket.on("rocketExploded", RocketSystem.handleExploded);
        gameSocket.on("healthPackTaken", MapSystem.healthPackTaken);
        gameSocket.on("healthPackRespawned", MapSystem.healthPackRespawned);
        gameSocket.on("remoteGrappleStart", ({ playerId, origin, direction }) => {
            const playerObj = GameSystem.getPlayer(playerId);
            GrappleSystem.remoteGrappleStart({ playerId, origin, direction, playerObj });
        });
        gameSocket.on("remoteGrappleEnd", GrappleSystem.remoteGrappleEnd);
        gameSocket.on("respawn", handleRespawn);
        gameSocket.on("playerDied", handlePlayerDied);
        gameSocket.on("serverMessage", handleServerMessage);
        gameSocket.on("heartbeatAck", handleHeartbeatAck);
    }

    function sendHeartbeatIfNeeded() {
        const now = Date.now();
        if (gameSocket?.connected) {
            if (now - lastServerResponse > 60000) {
                console.warn("No heartbeatAck from game server. Leaving game.");
                GameSystem.leaveGame();
                return;
            }
            if (now - lastHeartbeat > 5000) {
                gameSocket.emit("heartbeat");
                lastHeartbeat = now;
            }
        }
    }

    function handleHeartbeatAck() {
        lastServerResponse = Date.now();
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
            if (rotation) player.rotation.y = rotation.y;
        }
        EventBus.emit("player:animated", { playerId: id, isGrounded, isIdle });
    }

    function handlePlayerDisconnected(id) {
        if (PlayerSystem.getLocalPlayerId() === id) {
            alert("Disconnected");
            GameSystem.leaveGame();
        } else {
            GameSystem.removePlayer(id);
        }
    }

    function handleRespawn({ playerId, position, health }) {
        const player = GameSystem.getPlayer(playerId);
        if (player) {
            player.visible = true;
            player.position.set(position.x, position.y, position.z);
        }
        EventBus.emit("player:respawned", { playerId, position, health });
    }

    function handlePlayerDied({ playerId, position, message, stats }) {
        const player = GameSystem.getPlayer(playerId);
        if (player) player.visible = false;
        EventBus.emit("player:died", { playerId, message, position, stats });
    }

    function handleServerMessage({ message }) {
        EventBus.emit("game:message", { message });
    }

    function emitToLobby(event, payload, callback) {
        if (!lobbySocket?.connected) {
            console.error("Lobby socket not connected");
            return;
        }
        lobbySocket.emit(event, payload, callback);
    }

    function getGameSocket() {
        return gameSocket;
    }

    EventBus.on("player:moved", ({ roomId, position, yaw, playerId, isGrounded, isIdle }) => {
        gameSocket.emit("move", {
            roomId: roomId,
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: 0, y: yaw, z: 0 },
            isIdle: isIdle,
            isGrounded: isGrounded
        });
    });

    EventBus.on("player:shot", ({ roomId, origin, direction, laserId }) => {
        gameSocket.emit('shoot', {
            roomId: roomId,
            origin: origin,
            direction: direction,
            id: laserId
        });
    });

    EventBus.on("player:machinegunFire", ({ roomId, origin, direction }) => {
        gameSocket.emit('machinegunFire', {
            roomId: roomId,
            origin: origin,
            direction: direction
        });
    });

    EventBus.on("player:shotgunFire", ({ roomId, origin, direction }) => {
        gameSocket.emit('shotgunFire', {
            roomId: roomId,
            origin: origin,
            direction: direction
        });
    });

    EventBus.on("player:launchRocket", ({ roomId, origin, direction, rocketId }) => {
        gameSocket.emit('launchRocket', {
            roomId: roomId,
            origin: origin,
            direction: direction,
            id: rocketId
        });
    });

    EventBus.on("player:grappleStarted", ({ roomId, origin, direction }) => {
        gameSocket.emit('grappleStart', {
            roomId: roomId,
            origin: origin,
            direction: direction
        });
    });

    EventBus.on("player:grappleEnded", ({ roomId }) => {
        gameSocket.emit('grappleEnd', { roomId });
    });


    return {
        init,
        connectToGameSocket,
        emitToLobby,
        getGameSocket
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
        if (!UISystem.validatePlayerName()) {
            alert("Enter a name");
            throw new Error("Missing player name");
        }

        const mapName = UISystem.getSelectedMap();
        const modelName = `Astronaut${Math.floor(Math.random() * 3) + 1}.glb`;
        UISystem.savePlayerName();

        const { roomId: id, roomUrl, health } = await new Promise((resolve) => {
            NetworkSystem.emitToLobby("createRoom", { name: playerName, modelName, mapName }, resolve);
        });

        roomId = id;
        await connectToGame(roomUrl, playerName, modelName, health, mapName);
    }

    async function joinRoom(idOverride = null) {
        const playerName = UISystem.getPlayerName();
        if (!UISystem.validatePlayerName()) {
            alert("Enter a name");
            throw new Error("Missing player name");
        }

        const joinId = idOverride || UISystem.getRoomId();
        const modelName = `Astronaut${Math.floor(Math.random() * 3) + 1}.glb`;
        UISystem.savePlayerName();

        const { roomUrl, health, error } = await new Promise((resolve) => {
            NetworkSystem.emitToLobby("joinRoom", { roomId: joinId, name: playerName, modelName }, resolve);
        });

        if (error) throw new Error(error);

        roomId = joinId;
        await connectToGame(roomUrl, playerName, modelName, health, null);
    }

    async function connectToGame(roomUrl, playerName, modelName, health, mapName) {
        return new Promise(async (resolve, reject) => {
            try {
                await NetworkSystem.connectToGameSocket(roomUrl, roomId, playerName, modelName, health, mapName);
            }
            catch (err) {
                console.warn("Game socket failed to connect:", err.message);
                return reject(err);
            }

            EventBus.once("map:loaded", () => {
                const pid = NetworkSystem.getGameSocket().id;
                const playerObj = addPlayer(pid, 0, 0, 0, playerName, modelName);
                gameStarted = true;

                const gameState = new GameState({
                    roomId,
                    playerId: pid,
                    playerObj,
                    octree: MapSystem.getOctree(),
                    players,
                    requiresPrecisePhysics: MapSystem.isRequiringPrecisePhysics()
                });

                EventBus.emit("game:started", gameState);
                EventBus.emit("player:healthChanged", { playerId: pid, health });
                resolve();
            });
        });
    }

    function leaveGame() {
        NetworkSystem.getGameSocket()?.disconnect();
        for (const id in players) scene.remove(players[id]);
        Object.keys(players).forEach(id => delete players[id]);
        gameStarted = false;
        roomId = null;
        EventBus.emit("game:ended");
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
            model.scale.set(0.7, 0.7, 0.7);

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
            group.add(model);
        });

        // === Add name tag for remote players ===
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

    return {
        createRoom,
        joinRoom,
        leaveGame,
        getPlayer: id => players[id],
        isGameStarted: () => gameStarted,
        getRoomId: () => roomId,
        update: delta => {
            for (const id in players) {
                const player = players[id];
                player?.userData.nameTag?.lookAt(CameraSystem.getCamera().position);
                player?.userData.mixer?.update(delta);
            }
        },
        addPlayer,
        removePlayer: id => {
            if (players[id]) {
                scene.remove(players[id]);
                delete players[id];
            }
        }
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