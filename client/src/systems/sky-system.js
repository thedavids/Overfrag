import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EventBus, GameState } from 'shared';

export function createSkySystem({ scene }) {
    let moon, sky, skyUniforms, stars;

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => {
        gameState = gs;
        init();
    });
    EventBus.on("game:ended", clear);

    function init() {
        // Sky dome
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
    }

    function update(delta) {
        if (!gameState.playerObj) return;

        const now = Date.now();
        const secondsUTC = (now % 86400000) / 1000; // seconds since midnight UTC
        const skyTime = secondsUTC;

        const playerPos = gameState.playerObj.position;
        const angle = skyTime * 0.02;

        // Moon position
        const radius = 3000;
        const moonOffset = new THREE.Vector3(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
            0
        );
        moon.position.copy(playerPos).add(moonOffset).addScalar(1000);
        moon.lookAt(playerPos);

        // Fade effect
        const fade = 1;
        if (stars) stars.material.opacity = fade * 1.5;
        moon.material.opacity = fade * 1.5;

        if (skyUniforms) {
            skyUniforms['rayleigh'].value = 2 - fade * 1.8;
        }
    }

    return {
        update
    };
}
