import * as THREE from 'three';
import { EventBus } from './event-bus.js';
import { GameState } from './game-state.js';
import { OctreeNode, computeMapBounds } from './octree.js';
import { ModelsDictionary } from './models-dictionary.js';
import { TexturesDictionary } from './textures-dictionary.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// === MapSystem Begin ===
export function createMapSystem({ scene, isHeadless = false }) {
    const THIN_GEOMETRY_THRESHOLD = 0.01;

    const mapObjects = [];
    const healthPacks = [];

    let gameState = new GameState();
    EventBus.on("game:started", (gs) => { gameState = gs; });
    EventBus.on("game:ended", () => {
        clearMap();
        gameState.clear();
    });

    let mapLoaded = false;
    let octree = null;
    let requiresPrecisePhysics = false;

    async function loadMap(rawMapData) {
        clearMap();
        mapLoaded = false;

        const mapData = structuredClone(rawMapData);
        if (isHeadless !== true) {
            const mapObjectPromises = mapData.objects.map((obj, i) => loadMapObject(obj, i));
            await Promise.all(mapObjectPromises);
            await waitFrames();
            finalizeWorldBoxes(mapObjects);
        }

        loadHealthPacks(mapData.healthPacks || []);

        if (isHeadless !== true) {
            buildOctree(mapObjects);
        }
        else {
            octree = OctreeNode.fromJSON(mapData.octree);
        }

        mapLoaded = true;
    }

    async function loadMapObject(obj, i) {
        if (obj.file && obj.model) {
            return loadModelObject(obj, i);
        } else {
            return loadSimpleGeometry(obj, i);
        }
    }

    async function loadModelObject(obj, i) {
        try {
            const clone = await ModelsDictionary.get(obj.file, obj.model);
            clone.position.set(obj.position.x, obj.position.y, obj.position.z);

            if (obj.rotation) {
                clone.rotation.set(
                    THREE.MathUtils.degToRad(obj.rotation.x || 0),
                    THREE.MathUtils.degToRad(obj.rotation.y || 0),
                    THREE.MathUtils.degToRad(obj.rotation.z || 0)
                );
            }

            if (obj.scale) {
                clone.scale.set(obj.scale.x ?? 1, obj.scale.y ?? 1, obj.scale.z ?? 1);
            }

            clone.name = `${obj.model}_${i}`;

            const groupBox = new THREE.Box3().setFromObject(clone);
            const groupSize = new THREE.Vector3();
            groupBox.getSize(groupSize);
            clone.userData.box = groupBox;
            clone.size = [groupSize.x, groupSize.y, groupSize.z];
            clone.updateMatrixWorld(true);

            clone.traverse(child => {
                if (!child.isMesh || !child.geometry?.attributes?.position) return;

                const flattened = child.clone();
                flattened.geometry = child.geometry.clone();
                flattened.applyMatrix4(child.matrixWorld);
                flattened.updateMatrixWorld(true);

                flattened.geometry.computeBoundsTree = computeBoundsTree;
                flattened.geometry.disposeBoundsTree = disposeBoundsTree;
                flattened.geometry.computeBoundsTree();

                if (requiresPrecisePhysics === false) {
                    requiresPrecisePhysics = isMeshThinViaBVH(flattened, THIN_GEOMETRY_THRESHOLD);
                }

                const box = flattened.geometry.boundingBox.clone().applyMatrix4(flattened.matrixWorld);
                const size = new THREE.Vector3();
                box.getSize(size);

                flattened.userData.box = box;
                flattened.size = [size.x, size.y, size.z];

                scene?.add(flattened);
                mapObjects.push(flattened);
            });
        } catch (err) {
            console.warn(`⚠️ Could not load model: ${obj.model} from ${obj.file}`, err);
        }
    }

    async function loadSimpleGeometry(obj, i) {
        let geometry;
        switch (obj.type) {
            case "box":
            case "ground":
                geometry = new THREE.BoxGeometry(...obj.size);
                break;
            default:
                console.warn("Unknown geometry type:", obj.type);
                return;
        }

        let material;
        if (obj.texture) {
            const texture = await TexturesDictionary.get(obj.texture, obj.texture);
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.repeat.set(
                Math.ceil(obj.size[0] / 10),
                Math.ceil(obj.size[2] / 10)
            );
            texture.needsUpdate = true;
            material = new THREE.MeshBasicMaterial({ map: texture });
        } else {
            material = new THREE.MeshBasicMaterial({ color: obj.color || "#888" });
        }

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
        mesh.name = `${obj.type}_${i}`;
        mesh.updateMatrixWorld(true);

        mesh.geometry.computeBoundsTree = computeBoundsTree;
        mesh.geometry.disposeBoundsTree = disposeBoundsTree;
        mesh.geometry.computeBoundsTree();

        if (requiresPrecisePhysics === false) {
            requiresPrecisePhysics = isMeshThinViaBVH(mesh, THIN_GEOMETRY_THRESHOLD);
        }

        const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        const size = new THREE.Vector3();
        box.getSize(size);
        mesh.userData.box = box;
        mesh.size = [size.x, size.y, size.z];

        scene?.add(mesh);
        mapObjects.push(mesh);
    }

    function loadHealthPacks(data) {
        for (const pack of data) {
            const mesh = createHealthPackMesh();
            mesh.position.set(pack.position.x, pack.position.y, pack.position.z);
            mesh.userData.id = pack.id;
            mesh.userData.active = pack.available;
            scene?.add(mesh);
            healthPacks.push(mesh);
        }
    }

    function createHealthPackMesh() {
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const group = new THREE.Group();
        group.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), material));
        group.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), material));
        return group;
    }

    function waitFrames(n = 3) {
        return new Promise(resolve => {
            let count = 0;
            const next = () => {
                if (++count >= n) resolve();
                else requestAnimationFrame(next);
            };
            next();
        });
    }

    function finalizeWorldBoxes(objs) {
        objs.forEach(obj => {
            obj.updateMatrixWorld(true);
            obj.userData.box = new THREE.Box3().setFromObject(obj);
        });
    }

    function buildOctree(objs) {
        const bounds = computeMapBounds(objs);
        octree = new OctreeNode(bounds.center, bounds.size * 2);
        for (const mesh of objs) {
            mesh.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(mesh);
            const size = new THREE.Vector3();
            box.getSize(size);
            const center = new THREE.Vector3();
            box.getCenter(center);
            mesh.userData.box = box;
            mesh.size = [size.x, size.y, size.z];
            mesh.center = center;
            octree.insert(mesh);
        }
    }

    function healthPackTaken({ id, targetPlayerId, health }) {
        const pack = healthPacks.find(p => p.userData.id === id);
        if (pack) {
            EventBus.emit("player:healthChanged", { playerId: targetPlayerId, health });
            pack.visible = false;
            pack.userData.active = false;
        }
    }

    function healthPackRespawned({ id }) {
        const pack = healthPacks.find(p => p.userData.id === id);
        if (pack) {
            pack.visible = true;
            pack.userData.active = true;
        }
    }

    function update(delta) {
        for (const pack of healthPacks) {
            if (pack.userData.active) {
                pack.rotation.y += delta * 2;
            }
        }
    }

    function clearMap() {
        mapObjects.forEach(o => scene?.remove(o));
        mapObjects.length = 0;
        healthPacks.forEach(p => scene?.remove(p));
        healthPacks.length = 0;
        octree = null;
        mapLoaded = false;
        requiresPrecisePhysics = false;
    }

    function isMeshThinViaBVH(mesh, threshold) {
        const bbox = mesh.geometry.boundingBox;
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const min = Math.min(size.x, size.y, size.z);
        return (min < threshold);
    }

    return {
        loadMap,
        clearMap,
        getMapObjects: () => mapObjects,
        getOctree: () => octree,
        getHealthPacks: () => healthPacks,
        isLoaded: () => mapLoaded,
        isRequiringPrecisePhysics: () => requiresPrecisePhysics,
        healthPackTaken,
        healthPackRespawned,
        update
    };
}