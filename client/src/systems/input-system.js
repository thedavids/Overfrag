import { EventBus, GameState } from 'shared';

export function createInputSystem({
    document,
    window,
    navigator,
    btnJump,
    btnFire,
    btnGrapple,
    btnSwitch,
    touchWheel,
}) {
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

    const defaultSettings = {
        keyBindings: {
            jump: ' ',
            fire: 'f',
            grapple: 'g',
            toggleView: 'v',
            showStats: 'm',
            switchWeapon: ['1', '2', '3', '4', '5']
        },
        lookSensitivity: 0.002,
        invertY: false
    };

    const settings = {
        ...defaultSettings,
        ...JSON.parse(localStorage.getItem("gameInputSettings") || '{}')
    };

    function saveSettings(newSettings) {
        Object.assign(settings, newSettings);
        localStorage.setItem("gameInputSettings", JSON.stringify(settings));
    }

    function restoreSettings() {
        Object.assign(settings, defaultSettings);
        localStorage.removeItem("gameInputSettings");

        document.getElementById("sensitivitySlider").value = settings.lookSensitivity;
        document.getElementById("invertYCheckbox").checked = settings.invertY;
        document.getElementById("keyJump").value = settings.keyBindings.jump;
        document.getElementById("keyFire").value = settings.keyBindings.fire;
        document.getElementById("keyGrapple").value = settings.keyBindings.grapple;
    }

    function isGameStarted() {
        return !!gameState.playerObj;
    }

    function requestJump() {
        jumpRequested = true;
        jumpRequestTime = performance.now();
    }

    function clearJumpBuffer() {
        jumpRequested = false;
    }

    function isJumpBuffered() {
        return jumpRequested && performance.now() - jumpRequestTime < JUMP_BUFFER_TIME;
    }

    function getKeyState() {
        return keyState;
    }

    function getLookAngles() {
        return { playerYaw, playerPitch };
    }

    function handleKeydown(key) {
        const { keyBindings } = settings;
        if (key === keyBindings.jump) requestJump();
        else if (key === keyBindings.fire) EventBus.emit("input:shootBegin");
        else if (key === keyBindings.grapple) EventBus.emit("input:fireGrapple");
        else if (key === keyBindings.toggleView) EventBus.emit("input:toggleView");
        else if (key === keyBindings.showStats) EventBus.emit("input:showStats");
        else if (keyBindings.switchWeapon.includes(key)) {
            EventBus.emit("input:switchWeapon", { weaponId: parseInt(key) });
        }
    }

    function handleKeyup(key) {
        const { keyBindings } = settings;
        if (key === keyBindings.fire) EventBus.emit("input:shootEnd");
        else if (key === keyBindings.grapple) EventBus.emit("input:releaseGrapple");
    }

    function setup() {
        document.addEventListener('keydown', e => {
            if (!isGameStarted()) return;
            const key = e.key.toLowerCase();
            keyState[key] = true;
            handleKeydown(key);
        });

        document.addEventListener('keyup', e => {
            if (!isGameStarted()) return;
            const key = e.key.toLowerCase();
            keyState[key] = false;
            handleKeyup(key);
        });

        if (btnJump) {
            btnJump.addEventListener('touchstart', e => {
                e.preventDefault();
                requestJump();
            }, { passive: false });
        }

        if (btnFire) {
            btnFire.addEventListener('touchstart', e => {
                e.preventDefault();
                EventBus.emit("input:shootBegin");
            }, { passive: false });

            ['touchend', 'touchcancel'].forEach(evt =>
                btnFire.addEventListener(evt, () => EventBus.emit("input:shootEnd"))
            );
        }

        if (btnGrapple) {
            btnGrapple.addEventListener('touchstart', e => {
                e.preventDefault();
                EventBus.emit("input:fireGrapple");
            }, { passive: false });

            ['touchend', 'touchcancel'].forEach(evt =>
                btnGrapple.addEventListener(evt, () => EventBus.emit("input:releaseGrapple"))
            );
        }

        if (btnSwitch) {
            btnSwitch.addEventListener('touchstart', e => {
                e.preventDefault();
                EventBus.emit("input:nextWeapon");
            }, { passive: false });
        }

        // Touch Wheel Movement
        const keyMapWheel = { up: 'w', down: 's', left: 'a', right: 'd' };
        let wheelTouchId = null;
        let wheelStart = null;

        function updateDirectionFromAngle(angle) {
            for (const key of Object.values(keyMapWheel)) keyState[key] = false;
            if (angle >= -Math.PI / 4 && angle < Math.PI / 4) keyState[keyMapWheel.right] = true;
            else if (angle >= Math.PI / 4 && angle < 3 * Math.PI / 4) keyState[keyMapWheel.down] = true;
            else if (angle >= -3 * Math.PI / 4 && angle < -Math.PI / 4) keyState[keyMapWheel.up] = true;
            else keyState[keyMapWheel.left] = true;
        }

        if (touchWheel) {
            touchWheel.addEventListener('touchstart', e => {
                const touch = e.changedTouches[0];
                wheelTouchId = touch.identifier;
                wheelStart = { x: touch.clientX, y: touch.clientY };
                const rect = touchWheel.getBoundingClientRect();
                const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                const dx = touch.clientX - center.x;
                const dy = touch.clientY - center.y;
                const angle = Math.atan2(dy, dx);
                updateDirectionFromAngle(angle);
                e.preventDefault();
            }, { passive: false });

            touchWheel.addEventListener('touchmove', e => {
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

            touchWheel.addEventListener('touchend', e => {
                if ([...e.changedTouches].some(t => t.identifier === wheelTouchId)) {
                    clearWheel();
                }
            });

            touchWheel.addEventListener('touchcancel', clearWheel);
        }

        document.addEventListener('gesturestart', e => e.preventDefault());
        document.addEventListener('gesturechange', e => e.preventDefault());
        document.addEventListener('gestureend', e => e.preventDefault());

        const isTouchDevice = () => (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            navigator.userAgent.includes('iPad')
        );

        document.addEventListener('mousedown', e => {
            if (!isGameStarted() || isTouchDevice()) return;
            if (e.button === 0) EventBus.emit("input:shootBegin");
            else if (e.button === 1 || e.button === 2) {
                EventBus.emit("input:fireGrapple");
                e.preventDefault();
            }
        });

        document.addEventListener('mouseup', e => {
            if (!isGameStarted() || isTouchDevice()) return;
            if (e.button === 0) EventBus.emit("input:shootEnd");
            else if (e.button === 1 || e.button === 2) {
                EventBus.emit("input:releaseGrapple");
                e.preventDefault();
            }
        });

        const controlButtons = document.getElementsByClassName("btnControls");
        for (const btn of controlButtons) {
            btn.addEventListener("click", () => {
                document.getElementById("controlsModal").classList.remove("hidden");
                document.getElementById("sensitivitySlider").value = settings.lookSensitivity;
                document.getElementById("invertYCheckbox").checked = settings.invertY;
                document.getElementById("keyJump").value = settings.keyBindings.jump;
                document.getElementById("keyFire").value = settings.keyBindings.fire;
                document.getElementById("keyGrapple").value = settings.keyBindings.grapple;
            });
        }

        document.getElementById("resetControlsBtn").addEventListener("click", () => {
            restoreSettings();
        });

        document.getElementById("closeControlsBtn").addEventListener("click", () => {
            document.getElementById("controlsModal").classList.add("hidden");
        });

        document.getElementById("saveControlsBtn").addEventListener("click", () => {
            saveSettings({
                lookSensitivity: parseFloat(document.getElementById("sensitivitySlider").value),
                invertY: document.getElementById("invertYCheckbox").checked,
                keyBindings: {
                    ...settings.keyBindings,
                    jump: document.getElementById("keyJump").value || ' ',
                    fire: document.getElementById("keyFire").value || 'f',
                    grapple: document.getElementById("keyGrapple").value || 'g'
                }
            });

            document.getElementById("controlsModal").classList.add("hidden");
        });

    }

    function setupLookControls() {
        function enablePointerLock() {
            if (isGameStarted()) document.body.requestPointerLock();
        }

        function onMouseMove(e) {
            const sensitivity = settings.lookSensitivity;
            const invert = settings.invertY ? -1 : 1;

            playerYaw -= e.movementX * sensitivity;
            playerPitch -= e.movementY * sensitivity * invert;
            playerPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerPitch));
        }

        document.addEventListener('pointerlockchange', () => {
            const locked = document.pointerLockElement === document.body;
            if (locked) document.addEventListener('mousemove', onMouseMove);
            else document.removeEventListener('mousemove', onMouseMove);
        });

        document.addEventListener('click', (e) => {
            if (!isGameStarted()) return;

            const canvas = document.querySelector("#canvas-container canvas");
            if (canvas && e.target === canvas && document.pointerLockElement !== document.body) {
                enablePointerLock();
            }
        });

        document.addEventListener('touchstart', e => {
            if (!isGameStarted()) return;

            for (const touch of e.changedTouches) {
                if (lookTouchId === null && !touch.target.closest('#touch-controls')) {
                    lookTouchId = touch.identifier;
                    lastTouchPos = { x: touch.clientX, y: touch.clientY };
                }
            }
        }, false);

        document.addEventListener('touchmove', e => {
            if (!isGameStarted()) return;

            for (const touch of e.changedTouches) {
                if (touch.identifier === lookTouchId && lastTouchPos) {
                    const deltaX = touch.clientX - lastTouchPos.x;
                    const deltaY = touch.clientY - lastTouchPos.y;

                    const sensitivity = settings.lookSensitivity;
                    const invert = settings.invertY ? -1 : 1;

                    playerYaw -= deltaX * sensitivity;
                    playerPitch -= deltaY * sensitivity * invert;
                    playerPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerPitch));

                    lastTouchPos = { x: touch.clientX, y: touch.clientY };
                }
            }
        }, false);

        ['touchend', 'touchcancel'].forEach(evt =>
            document.addEventListener(evt, e => {
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
        requestJump,
        saveSettings,
        restoreSettings,
        settings
    };
}
