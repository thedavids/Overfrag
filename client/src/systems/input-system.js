
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

    function setup() {
        document.addEventListener('keydown', e => {
            if (!isGameStarted()) return;

            const key = e.key.toLowerCase();
            keyState[key] = true;

            if (key === ' ') requestJump();
            else if (key === 'g') EventBus.emit("input:fireGrapple");
            else if (key === 'f') EventBus.emit("input:shootBegin");
            else if (key === 'v') EventBus.emit("input:toggleView");
            else if (key === 'm') EventBus.emit("input:showMap");
            else if (key >= '1' && key <= '5') {
                EventBus.emit("input:switchWeapon", { weaponId: parseInt(key) });
            }
        });

        document.addEventListener('keyup', e => {
            if (!isGameStarted()) return;

            const key = e.key.toLowerCase();
            keyState[key] = false;

            if (key === 'g') EventBus.emit("input:releaseGrapple");
            if (key === 'f') EventBus.emit("input:shootEnd");
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
    }

    function setupLookControls() {
        function enablePointerLock() {
            if (isGameStarted()) document.body.requestPointerLock();
        }

        function onMouseMove(e) {
            playerYaw -= e.movementX * 0.002;
            playerPitch -= e.movementY * 0.002;
            playerPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, playerPitch));
        }

        document.addEventListener('pointerlockchange', () => {
            const locked = document.pointerLockElement === document.body;
            if (locked) document.addEventListener('mousemove', onMouseMove);
            else document.removeEventListener('mousemove', onMouseMove);
        });

        document.addEventListener('click', () => {
            if (!isGameStarted()) return;
            if (document.pointerLockElement !== document.body) enablePointerLock();
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

                    playerYaw -= deltaX * 0.008;
                    playerPitch -= deltaY * 0.008;
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
        requestJump
    };
}
