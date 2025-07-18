import * as THREE from 'three';
import { EventBus, GameState } from 'shared';

export function createAudioSystem({ scene, cameraSystem }) {

    let isTabActive = true;
    document.addEventListener("visibilitychange", () => {
        isTabActive = !document.hidden;
    });

    // We’ll cache decoded buffers so we don’t re-decode every shot
    const audioBuffers = {};
    const listener = new THREE.AudioListener();
    const audioLoader = new THREE.AudioLoader();
    const activeSounds = [];

    function init() {
        cameraSystem.getCamera().add(listener); // camera = your player view
    }

    function loadAudioBuffer(url, onLoad) {
        if (audioBuffers[url]) {
            onLoad(audioBuffers[url]);
            return;
        }
        audioLoader.load(url, (buffer) => {
            audioBuffers[url] = buffer;
            onLoad(buffer);
        });
    }

    function playOneShotPositional(buffer, position, volume = 0.8) {
        if (isTabActive === false) {
            return;
        }

        // Create a temporary PositionalAudio node
        const sound = new THREE.PositionalAudio(listener);
        sound.setBuffer(buffer);
        sound.setVolume(volume);
        sound.setRefDistance(5);      // how quickly it attenuates
        sound.setRolloffFactor(1);    // tweak falloff
        sound.position.copy(position);

        scene.add(sound);
        sound.play();

        // Remove once finished to avoid leaking objects
        const duration = buffer.duration * 1000;
        activeSounds.push({ sound, life: duration + 50 });
    }

    function playSoundSequence(soundNames, position, volume = 0.1) {
        if (isTabActive === false) {
            return;
        }

        const buffers = [];

        function loadAll(index = 0) {
            if (index >= soundNames.length) {
                playAll(0);
                return;
            }

            const name = soundNames[index];
            if (audioBuffers[name]) {
                buffers[index] = audioBuffers[name];
                loadAll(index + 1);
            } else {
                audioLoader.load(name, (buffer) => {
                    audioBuffers[name] = buffer;
                    buffers[index] = buffer;
                    loadAll(index + 1);
                });
            }
        }

        function playAll(index) {
            if (index >= buffers.length) return;

            const sound = new THREE.PositionalAudio(listener);
            sound.setBuffer(buffers[index]);
            sound.setVolume(volume);
            sound.setRefDistance(5);
            sound.setRolloffFactor(1);
            sound.position.copy(position);

            scene.add(sound);
            sound.play();

            sound.onEnded = () => {
                scene.remove(sound);
                sound.disconnect();
                playAll(index + 1);
            };

            activeSounds.push({ sound, life: buffers[index].duration * 1000 + 50 });
        }

        loadAll(); // start the chain
    }

    EventBus.on("laserFired", ({ roomId, origin, direction, laserId }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/blaster1.wav', (buffer) => {
            playOneShotPositional(buffer, origin, 0.3);
        });
    });

    EventBus.on("shotgunFired", ({ roomId, origin, direction }) => {
        playSoundSequence([
            'https://www.dailysummary.io/sounds/shotgun1.wav',
            'https://www.dailysummary.io/sounds/shotgun1reload.wav'
        ], origin, 0.05);
    });

    EventBus.on("machinegunFired", ({ roomId, origin, direction }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/machingun1.wav', (buffer) => {
            playOneShotPositional(buffer, origin, 0.3);
        });
    });

    EventBus.on("rocketLaunched", ({ roomId, origin, direction, laserId }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/rocketlaunch1.wav', (buffer) => {
            playOneShotPositional(buffer, origin, 0.6);
        });
    });

    EventBus.on("rocketExploded", ({ roomId, position }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/rocket_explosion.wav', (buffer) => {
            playOneShotPositional(buffer, position, 1.2);
        });
    });

    EventBus.on("railgunFired", ({ roomId, origin, direction }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/railgun1.wav', (buffer) => {
            playOneShotPositional(buffer, origin, 0.5);
        });
    });

    EventBus.on("grappleAttached", ({ roomId, origin, direction }) => {
        loadAudioBuffer('https://www.dailysummary.io/sounds/hook.wav', (buffer) => {
            playOneShotPositional(buffer, origin, 2);
        });
    });

    function update(delta) {
        activeSounds.forEach((item, i) => {
            item.life -= delta;
            if (item.life <= 0) {
                scene.remove(item.sound);
                item.sound.disconnect();
                activeSounds.splice(i, 1);
            }
        });
    }

    return {
        init,
        update
    };
}

