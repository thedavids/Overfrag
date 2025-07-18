import * as THREE from 'three';
import { EventBus } from 'shared';
import { TexturesDictionary } from 'shared';

export function createEffectSystem({ scene, document }) {

    let isTabActive = true;
    document.addEventListener("visibilitychange", () => {
        isTabActive = !document.hidden;
    });

    // === DamageNumberPool ===
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

    // === DamageTexturePool ===
    const DamageTexturePool = (() => {
        const cache = new Map();
        function createCanvasTexture(damage, color) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = 'bold 48px Arial';
            ctx.textAlign = 'center';
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#000';
            ctx.fillStyle = color;
            const text = damage.toString();
            ctx.strokeText(text, 32, 48);
            ctx.fillText(text, 32, 48);

            const texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            return texture;
        }
        return {
            get(damage, color = '#ffffff') {
                const key = `${damage}|${color}`;
                if (!cache.has(key)) {
                    cache.set(key, createCanvasTexture(damage, color));
                }
                return cache.get(key);
            }
        };
    })();

    // === Main Effect System ===
    const damageNumbers = [];
    const hitEffects = [];
    const bloodParticles = [];
    const muzzleFlashes = [];
    const activeTracers = [];
    const activeRocketExplosions = [];
    const activeRailSlugs = [];

    const sharedBloodGeometry = new THREE.SphereGeometry(0.05, 4, 4);
    const sharedBloodMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });

    const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.5 });

    const smokeMaterialPool = [];

    const _tempVec1 = new THREE.Vector3();
    const _tempVec2 = new THREE.Vector3();

    function createBloodAnimation(position, particleCount) {
        if (isTabActive === false) {
            return;
        }

        const fixedPos = new THREE.Vector3(position.x, position.y, position.z);
        for (let i = 0; i < particleCount; i++) {
            const particle = new THREE.Mesh(sharedBloodGeometry, sharedBloodMaterial);
            particle.position.copy(fixedPos);
            const velocity = new THREE.Vector3((Math.random() - 0.5), Math.random(), (Math.random() - 0.5))
                .normalize().multiplyScalar(Math.random() * 2);
            const life = 2.0 + Math.random() * 0.5;
            bloodParticles.push({ sprite: particle, velocity, life });
            scene.add(particle);
        }
    }

    function showDamageNumber(position, damage, color = '#ffffff') {
        if (isTabActive === false) {
            return;
        }

        const duration = 0.8;
        const startPos = new THREE.Vector3(position.x, position.y + 1.6, position.z);
        const floatOffset = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.8 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3);
        const sprite = DamageNumberPool.getSprite();
        const texture = DamageTexturePool.get(damage, color);
        const material = sprite.material;
        material.map = texture;
        material.opacity = 1;
        sprite.position.copy(startPos);
        sprite.scale.set(damage >= 20 ? 1.5 : 1.1, damage >= 20 ? 0.75 : 0.55, 1);
        damageNumbers.push({ sprite, material, startPos, floatOffset, elapsed: 0, duration });
    }

    function spawnMuzzleFlash(position, direction) {
        if (isTabActive === false) {
            return;
        }

        const flashPos = position.clone().add(direction.clone().multiplyScalar(0.2));
        const size = 0.3 + Math.random() * 0.2;

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
            spawnMuzzleFlash.texture = new THREE.CanvasTexture(canvas);
            spawnMuzzleFlash.material = new THREE.SpriteMaterial({ map: spawnMuzzleFlash.texture, transparent: true });
        }

        const sprite = new THREE.Sprite(spawnMuzzleFlash.material);
        sprite.position.copy(flashPos);
        sprite.scale.set(size, size, 1);
        scene.add(sprite);

        const light = new THREE.PointLight(0xffaa00, 5, 10);
        light.position.copy(flashPos);
        scene.add(light);

        muzzleFlashes.push({ sprite, light, baseScale: size, elapsed: 0, duration: 0.1 });
    }

    function spawnTracer(origin, direction, length = 4) {
        if (isTabActive === false) {
            return;
        }

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
        activeTracers.push({ mesh: tracer, geometry, material, elapsed: 0, duration: 0.08 });
    }

    function returnMaterialToPool(material) {
        material.opacity = 0.6;
        smokeMaterialPool.push(material);
    }

    function getPooledMaterial(texture) {
        return smokeMaterialPool.pop() || new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
    }

    async function spawnHitEffect(position, normal) {
        if (isTabActive === false) {
            return;
        }

        const texture = await TexturesDictionary.get('smokeTransparent', 'https://www.dailysummary.io/textures/smoke_transparent.png');
        const puffCount = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < puffCount; i++) {
            const offset = new THREE.Vector3((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1);
            const mat = getPooledMaterial(texture);
            const sprite = new THREE.Sprite(mat);
            sprite.position.copy(position.clone().add(normal.clone().multiplyScalar(0.05)).add(offset));
            sprite.scale.setScalar(0.4 + Math.random() * 0.2);
            scene.add(sprite);
            const baseScale = sprite.scale.x;
            hitEffects.push({ sprite, baseScale, elapsed: 0, duration: 0.4 });
        }
    }

    function createRocketExplosion(position) {
        if (isTabActive === false) {
            return;
        }

        const geometry = new THREE.SphereGeometry(1, 16, 16);
        const mesh = new THREE.Mesh(geometry, explosionMaterial.clone());
        mesh.position.copy(position);
        mesh.scale.set(0.01, 0.01, 0.01);
        scene.add(mesh);
        activeRocketExplosions.push({ mesh, geometry, material: mesh.material, elapsed: 0, duration: 0.7 });
    }

    const beamGeometryCache = new Map();
    const spiralMaterial = new THREE.MeshBasicMaterial({
        color: 0x66ccff,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const beamMaterial = new THREE.MeshBasicMaterial({
        color: 0x00aaff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });

    function getBeamGeometry(length) {
        if (!beamGeometryCache.has(length)) {
            beamGeometryCache.set(length, new THREE.CylinderGeometry(0.05, 0.05, length, 8, 1, true));
        }
        return beamGeometryCache.get(length);
    }

    function spawnRailSlug(origin, direction, targetPoint = null) {
        const defaultBeamLength = 5000;
        const spiralRadius = 0.15;

        // === Beam length
        const beamLength = targetPoint ? origin.distanceTo(targetPoint) : defaultBeamLength;

        // === Beam ===
        const beamMesh = new THREE.Mesh(getBeamGeometry(beamLength), beamMaterial);
        const dir = direction.clone().normalize();
        beamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        beamMesh.position.copy(origin).add(dir.clone().multiplyScalar(beamLength / 2));
        scene.add(beamMesh);

        // === Spiral ===
        const totalPoints = Math.min(300, Math.floor(beamLength * 2));
        const loops = Math.max(1, Math.floor(beamLength / 2));

        const spiralPoints = [];
        for (let i = 0; i <= totalPoints; i++) {
            const t = i / totalPoints;
            const angle = t * Math.PI * 2 * loops;
            spiralPoints.push(new THREE.Vector3(
                Math.cos(angle) * spiralRadius,
                t * beamLength,
                Math.sin(angle) * spiralRadius
            ));
        }

        const spiralCurve = new THREE.CatmullRomCurve3(spiralPoints);
        const spiralGeometry = new THREE.TubeGeometry(spiralCurve, totalPoints, 0.01, 6, false);
        const spiralMesh = new THREE.Mesh(spiralGeometry, spiralMaterial);
        spiralMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        spiralMesh.position.copy(origin);
        scene.add(spiralMesh);

        // === Lifetime tracking
        activeRailSlugs.push({ beamMesh, spiralMesh, life: 0.6 });
    }

    function update(delta) {
        damageNumbers.forEach((dn, i) => {
            dn.elapsed += delta;
            const t = dn.elapsed / dn.duration;
            if (t >= 1) {
                DamageNumberPool.releaseSprite(dn.sprite);
                damageNumbers.splice(i, 1);
            } else {
                _tempVec1.copy(dn.floatOffset).multiplyScalar(t);
                dn.sprite.position.copy(_tempVec2.copy(dn.startPos).add(_tempVec1));
                dn.material.opacity = 1 - t;
            }
        });

        hitEffects.forEach((p, i) => {
            p.elapsed += delta;
            const t = p.elapsed / p.duration;
            if (t >= 1) {
                scene.remove(p.sprite);
                returnMaterialToPool(p.sprite.material);
                hitEffects.splice(i, 1);
            } else {
                const scale = p.baseScale + t * 0.5;
                p.sprite.scale.set(scale, scale, scale);
                p.sprite.material.opacity = 0.6 * (1 - t);
            }
        });

        bloodParticles.forEach((p, i) => {
            p.sprite.position.addScaledVector(p.velocity, delta);
            p.life -= delta;
            if (p.life <= 0) {
                scene.remove(p.sprite);
                bloodParticles.splice(i, 1);
            }
        });

        muzzleFlashes.forEach((flash, i) => {
            flash.elapsed += delta;
            const t = flash.elapsed / flash.duration;
            if (t >= 1) {
                scene.remove(flash.sprite);
                scene.remove(flash.light);
                flash.sprite.material.dispose();
                muzzleFlashes.splice(i, 1);
            } else {
                const scale = flash.baseScale * (1 + t * 0.5);
                flash.sprite.scale.set(scale, scale, 1);
                flash.sprite.material.opacity = 1 - t;
            }
        });

        activeTracers.forEach((tracer, i) => {
            tracer.elapsed += delta;
            if (tracer.elapsed >= tracer.duration) {
                scene.remove(tracer.mesh);
                tracer.geometry.dispose();
                tracer.material.dispose();
                activeTracers.splice(i, 1);
            }
        });

        activeRocketExplosions.forEach((explosion, i) => {
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
        });

        activeRailSlugs.forEach((s, i) => {
            s.life -= delta;
            if (s.life <= 0) {
                scene.remove(s.beamMesh);
                scene.remove(s.spiralMesh);
                activeRailSlugs.splice(i, 1);
            }
        });
    }

    EventBus.on("player:tookDamage", ({ position, health, damage }) => {
        createBloodAnimation(position, 10);
        showDamageNumber(position, damage);
    });

    EventBus.on("player:died", ({ playerId, message, position }) => {
        createBloodAnimation(position, 30);
    });

    return {
        createBloodAnimation,
        spawnMuzzleFlash,
        spawnTracer,
        spawnHitEffect,
        createRocketExplosion,
        spawnRailSlug,
        update
    };
}
