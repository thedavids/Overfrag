import * as THREE from 'three';
import { EventBus } from 'shared';
import { GameState } from 'shared';

export function createUISystem({
    document,
    playerNameInput,
    roomIdInput,
    roomListDiv,
    menuEl,
    gameEl,
    infoEl,
    btnCreateRoom,
    btnJoinRoom,
    btnLeaveRoom,
    toggleViewBtn,
    serverMessageContainer,
    mapSelector
}) {
    let hudSprite;
    let hudScene;
    let crosshair = null;

    let gameState = new GameState();

    function init() {
        const saved = localStorage.getItem('playerName');
        if (saved && playerNameInput) playerNameInput.value = saved;

        hudScene = new THREE.Scene();
        createHud();
        createCrosshair();

        btnCreateRoom?.addEventListener("click", () => {
            btnCreateRoom.disabled = true;
            EventBus.emit("ui:createRoom", {
                onComplete: () => { btnCreateRoom.disabled = false; }
            });
        });

        btnJoinRoom?.addEventListener("click", () => {
            btnJoinRoom.disabled = true;
            EventBus.emit("ui:joinRoom", {
                onComplete: () => { btnJoinRoom.disabled = false; }
            });
        });

        btnLeaveRoom?.addEventListener("click", () => {
            EventBus.emit("ui:leaveRoom");
        });

        toggleViewBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            EventBus.emit("input:toggleView");
        });
    }

    EventBus.on("game:started", (gs) => {
        gameState = gs;
        showGameUI(`Room ID: ${gameState.roomId}`);
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

    EventBus.on("player:died", ({ message }) => showServerMessage(message));
    EventBus.on("game:message", ({ message }) => showServerMessage(message));

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
        return playerNameInput?.value.trim() || '';
    }

    function savePlayerName() {
        localStorage.setItem('playerName', getPlayerName());
    }

    function getRoomId() {
        return roomIdInput?.value.trim() || '';
    }

    function populateMapList(maps) {
        if (!mapSelector) return;
        mapSelector.innerHTML = '';
        maps.forEach(({ id, name }) => {
            const option = document.createElement('option');
            option.value = id;
            option.innerText = name;
            mapSelector.appendChild(option);
        });
    }

    function getSelectedMap() {
        return mapSelector?.value || '';
    }

    function renderRoomList(rooms, joinCallback) {
        if (!roomListDiv) return;
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

    function showServerMessage(text) {
        if (!serverMessageContainer) return;

        const el = document.createElement('div');
        el.innerText = text;
        el.style.padding = '5px 10px';
        el.style.marginBottom = '5px';
        el.style.background = 'rgba(0,0,0,0.7)';
        el.style.color = 'white';
        el.style.borderRadius = '4px';
        el.style.fontSize = '14px';

        serverMessageContainer.appendChild(el);
        setTimeout(() => el.remove(), 3000);
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
        getHudScene: () => hudScene,
        getCrosshair: () => crosshair,
        updateCrosshairPosition
    };
}
