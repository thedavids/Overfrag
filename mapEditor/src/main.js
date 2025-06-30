import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OctreeNode, computeMapBounds, EventBus, TexturesDictionary, ModelsDictionary, createMapSystem } from 'shared';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

let scene, camera, renderer, selected = null;
let keys = {}, pitch = 0, yaw = 0;
const velocity = new THREE.Vector3();
let prev = performance.now();
let overlayMode = "";
let copiedObjectData = null;
let axisScene, axisCamera, axisRenderer, axisHelper;

init();
initAxisHelper();
animate();

function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);
    camera.position.set(0, 5, 10);

    renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const light = new THREE.HemisphereLight(0xffffff, 0x444444);
    scene.add(light);

    // grid on XZ plane
    const gridSize = 1000;   // Overall size of the grid
    const gridDivisions = 200; // Number of divisions (1000 / 20 0= 5 units between lines)
    const gridColor = 0x888888;

    const grid = new THREE.GridHelper(gridSize, gridDivisions, gridColor, gridColor);
    grid.material.opacity = 0.3;
    grid.material.transparent = true;

    scene.add(grid);

    document.getElementById('modelSelect').addEventListener('change', onModelChange);
    document.getElementById('textureSelect').addEventListener('change', onTextureChange);
    document.getElementById('applyBtn').addEventListener('click', applyChanges);
    document.getElementById('addBtn').addEventListener('click', addObject);
    document.getElementById('deleteBtn').addEventListener('click', deleteObject);
    document.getElementById('loadBtn').addEventListener('click', loadMap);
    document.getElementById('exportBtn').addEventListener('click', exportMap);
    document.getElementById('overlayConfirmBtn').addEventListener('click', confirmOverlay);
    document.getElementById('overlayCancelBtn').addEventListener('click', closeOverlay);

    window.addEventListener('click', onClick);
    window.addEventListener('keydown', e => {
        keys[e.key.toLowerCase()] = true;

        // Ctrl+C or Cmd+C
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            if (selected && selected.userData.isEditable) {
                copiedObjectData = {
                    ...selected.userData,
                    position: { ...selected.position }  // clone position
                };
                console.log("Copied object", copiedObjectData);
            }
        }

        // Ctrl+V or Cmd+V
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            if (copiedObjectData) {
                const pasted = JSON.parse(JSON.stringify(copiedObjectData));
                // Slight offset so it's not inside the original
                pasted.position.x += 1;
                pasted.position.y += 1;
                pasted.position.z += 1;

                const newObj = createMapObject(pasted, true);
                selectObject(newObj);
                console.log("Pasted object");
            }
        }

    });
    window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
    window.addEventListener('mousemove', onMouseMove);

    window.addEventListener('resize', onWindowResize);
}

const loadedGLBCache = {};

async function onModelChange() {
    const url = document.getElementById("modelSelect").value;
    const subSelect = document.getElementById("submodelSelect");
    const subLabel = document.getElementById("submodelLabel");

    subSelect.innerHTML = "";
    subLabel.style.display = "none";

    if (!url) return;

    if (!loadedGLBCache[url]) {
        const loader = new GLTFLoader();
        const gltf = await new Promise((resolve, reject) =>
            loader.load(url, resolve, undefined, reject)
        );
        loadedGLBCache[url] = gltf.scene;
    }

    const scene = loadedGLBCache[url];
    const groups = [];

    scene.traverse(child => {
        if (child.isGroup || child.isMesh) {
            groups.push(child.name);
        }
    });

    // Remove duplicates
    const unique = [...new Set(groups)].filter(n => n);

    for (const name of unique) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        subSelect.appendChild(opt);
    }

    if (unique.length) {
        subLabel.style.display = "block";
    }
}

function initAxisHelper() {
    axisScene = new THREE.Scene();

    const size = 1.6;
    axisCamera = new THREE.OrthographicCamera(-size, size, size, -size, 0.1, 10);
    axisCamera.position.set(0, 0, 2);
    axisCamera.lookAt(0, 0, 0);

    const axisGroup = new THREE.Group();

    axisHelper = new THREE.AxesHelper(1);
    axisGroup.add(axisHelper);

    const labelX = makeTextLabel("X", "#ff0000");
    labelX.position.set(1.2, 0, 0);
    axisGroup.add(labelX);

    const labelY = makeTextLabel("Y", "#00ff00");
    labelY.position.set(0, 1.2, 0);
    axisGroup.add(labelY);

    const labelZ = makeTextLabel("Z", "#0000ff");
    labelZ.position.set(0, 0, 1.2);
    axisGroup.add(labelZ);

    axisScene.add(axisGroup);

    // Save references
    window.axisGroup = axisGroup;
    window.axisLabels = { x: labelX, y: labelY, z: labelZ };

    const canvas = document.getElementById('axisCanvas');
    axisRenderer = new THREE.WebGLRenderer({ canvas, alpha: true });
    axisRenderer.setSize(150, 150);
    axisRenderer.setPixelRatio(window.devicePixelRatio);
}

function makeTextLabel(text, color = "#ffffff") {
    const canvas = document.createElement("canvas");
    const size = 256;
    canvas.width = canvas.height = size;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);

    ctx.font = "bold 96px sans-serif";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, size / 2, size / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);

    return sprite;
}

function renderAxis() {
    // Sync axis helper orientation with camera
    if (axisGroup && axisCamera && axisRenderer && axisScene) {
        axisGroup.quaternion.copy(camera.quaternion); // Rotate helper group

        // Billboard labels to face the camera
        const labels = window.axisLabels;
        if (labels) {
            Object.values(labels).forEach(label => {
                label.quaternion.copy(axisCamera.quaternion);
            });
        }

        axisRenderer.render(axisScene, axisCamera);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function addTestObjects() {
    const map = [
        { type: "box", position: { x: 0, y: 0, z: 0 }, size: [4, 1, 4], color: "#ff0000" },
        { type: "box", position: { x: 6, y: 0, z: 0 }, size: [4, 1, 4], color: "#00ff00" },
    ];
    map.forEach(obj => createMapObject(obj, true));
}

async function createMapObject(obj, editable = false) {

    if (obj.file && obj.model) {
        const gltf = await ModelsDictionary.get(obj.file, obj.model); // uses your model loader
        const model = gltf.clone(true);

        if (obj.position) {
            model.position.set(obj.position.x, obj.position.y, obj.position.z);
        }

        if (obj.rotation) {
            model.rotation.y = (obj.rotation.y || 0) * Math.PI / 180;
        }

        if (obj.scale) {
            model.scale.set(obj.scale.x || 1, obj.scale.y || 1, obj.scale.z || 1);
        }

        model.userData = { ...obj, offset: model.userData.offset, baseSize: model.userData.baseSize, isEditable: editable, isRootModel: true };
        model.traverse(child => {
            child.userData = { ...child.userData, isEditable: editable };
            if (child !== model) {
                child.userData.parentModel = model;
            }
        });
        scene.add(model);
        return model;
    }

    let material;
    if (obj.texture) {
        const tex = await TexturesDictionary.get(obj.texture, obj.texture);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(Math.ceil(obj.size[0] / 10), Math.ceil(obj.size[2] / 10));
        material = new THREE.MeshBasicMaterial({ map: tex });
    } else {
        material = new THREE.MeshBasicMaterial({ color: obj.color || '#888' });
    }
    const geometry = new THREE.BoxGeometry(...obj.size);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
    mesh.userData = { ...obj, isEditable: editable };
    scene.add(mesh);
    return mesh;
}

function onClick(event) {
    if (event.target.closest('#editor-panel') || event.target.closest('#overlay')) return;

    const mouse = new THREE.Vector2(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children);
    const hit = intersects.find(i => i.object.userData.isEditable);
    if (hit) {
        let obj = hit.object;

        // Climb to root model group if possible
        if (obj.userData.parentModel) {
            obj = obj.userData.parentModel;
        }

        selectObject(obj);
    } else {
        if (selected?.__highlightMesh) {
            scene.remove(selected.__highlightMesh);
        }
        selected = null;
    }
}

function selectObject(obj) {
    if (selected?.__highlightMesh) {
        scene.remove(selected.__highlightMesh);
    }
    selected = obj;

    // Highlight: if geometry is available, clone it, else use bounding box helper
    let highlight;
    if (selected.geometry) {
        const geoHighlight = selected.geometry.clone();
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffff00,
            wireframe: true,
            depthTest: false,
            transparent: true,
            opacity: 0.8
        });
        highlight = new THREE.Mesh(geoHighlight, mat);
        highlight.position.copy(selected.position);
        highlight.rotation.copy(selected.rotation);
    } else {
        // Use Box3Helper as fallback for non-geometry objects (e.g., groups)
        const box = new THREE.Box3().setFromObject(selected);
        highlight = new THREE.Box3Helper(box, 0xffff00);
    }

    highlight.renderOrder = 999;
    highlight.userData.isHighlight = true;
    selected.__highlightMesh = highlight;
    scene.add(highlight);

    // Position
    document.getElementById('posX').value = obj.position.x;
    document.getElementById('posY').value = obj.position.y;
    document.getElementById('posZ').value = obj.position.z;

    // Rotation
    document.getElementById('rotX').value = THREE.MathUtils.radToDeg(obj.rotation.x).toFixed(1);
    document.getElementById('rotY').value = THREE.MathUtils.radToDeg(obj.rotation.y).toFixed(1);
    document.getElementById('rotZ').value = THREE.MathUtils.radToDeg(obj.rotation.z).toFixed(1);

    // Color
    if (obj.material?.color) {
        document.getElementById('color').value = '#' + obj.material.color.getHexString();
    } else {
        document.getElementById('color').value = '#888888'; // fallback
    }

    // Size
    let sizeX = 1, sizeY = 1, sizeZ = 1;
    const size = obj.userData.size;

    if (obj.geometry?.parameters) {
        sizeX = obj.geometry.parameters.width;
        sizeY = obj.geometry.parameters.height;
        sizeZ = obj.geometry.parameters.depth;
    } else if (size && size.length === 3) {
        sizeX = size[0]?.toFixed(2) || 1;
        sizeY = size[1]?.toFixed(2) || 1;
        sizeZ = size[2]?.toFixed(2) || 1;
    } else {
        const box = new THREE.Box3().setFromObject(obj);
        const vec = new THREE.Vector3();
        box.getSize(vec);
        sizeX = vec.x.toFixed(2);
        sizeY = vec.y.toFixed(2);
        sizeZ = vec.z.toFixed(2);
    }

    document.getElementById('sizeX').value = sizeX;
    document.getElementById('sizeY').value = sizeY;
    document.getElementById('sizeZ').value = sizeZ;

    // Texture
    const textureSelect = document.getElementById('textureSelect');
    const textureURL = obj.userData.texture || "";
    if (["https://www.dailysummary.io/textures/stone.jpg",
        "https://www.dailysummary.io/textures/hardwood2_diffuse.jpg",
        "https://www.dailysummary.io/textures/brick_diffuse.jpg"].includes(textureURL)) {
        textureSelect.value = textureURL;
    } else if (textureURL) {
        textureSelect.value = "custom";
        document.getElementById('texture').value = textureURL;
    } else {
        textureSelect.value = "";
        document.getElementById('texture').value = "";
    }

    // Model source
    const modelSelect = document.getElementById('modelSelect');
    const submodelSelect = document.getElementById('submodelSelect');
    const submodelLabel = document.getElementById('submodelLabel');

    if (obj.userData.file && obj.userData.model) {
        modelSelect.value = obj.userData.file;

        // Trigger change to populate submodels
        modelSelect.dispatchEvent(new Event('change'));

        // Wait a moment for submodel options to be populated
        setTimeout(() => {
            submodelSelect.value = obj.userData.model;
            submodelLabel.style.display = "block";
        }, 50); // small delay to allow population
    } else {
        modelSelect.value = "";
        submodelSelect.innerHTML = "";
        submodelLabel.style.display = "none";
    }

    onTextureChange();
}

async function applyChanges() {
    if (!selected) return;
    selected.position.x = parseFloat(document.getElementById('posX').value);
    selected.position.y = parseFloat(document.getElementById('posY').value);
    selected.position.z = parseFloat(document.getElementById('posZ').value);

    const rotX = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotX').value));
    const rotY = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotY').value));
    const rotZ = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotZ').value));
    selected.rotation.set(rotX, rotY, rotZ);

    const color = document.getElementById('color').value;
    let textureURL = document.getElementById('textureSelect').value;
    if (textureURL === "custom") {
        textureURL = document.getElementById('texture').value.trim();
    }

    const width = parseFloat(document.getElementById('sizeX').value);
    const height = parseFloat(document.getElementById('sizeY').value);
    const depth = parseFloat(document.getElementById('sizeZ').value);

    if (selected.geometry) {
        selected.geometry.dispose();
        selected.geometry = new THREE.BoxGeometry(width, height, depth);
    } else {
        // Use base size (original unscaled size)
        const base = selected.userData.baseSize;
        if (!base) {
            console.warn("Missing baseSize in userData; skipping scale update.");
            return;
        }

        const scale = new THREE.Vector3(
            width / base[0],
            height / base[1],
            depth / base[2]
        );

        selected.scale.copy(scale);
        selected.userData.scale = { x: scale.x, y: scale.y, z: scale.z };
        selected.userData.size = [width, height, depth];
    }

    selected.userData.size = [width, height, depth];
    selected.userData.texture = textureURL || undefined;

    if (textureURL && selected.material) {
        const tex = await TexturesDictionary.get(textureURL, textureURL);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(Math.ceil(width / 10), Math.ceil(depth / 10));
        selected.material.map = tex;
        selected.material.color.set(0xffffff);
        selected.material.needsUpdate = true;
    }
    else if (selected.material) {
        selected.material.map = null;
        selected.material.color.set(color || '#888888'); // apply selected color
        selected.material.needsUpdate = true;
    }

    if (selected?.__highlightMesh) {
        scene.remove(selected.__highlightMesh);
    }

    selectObject(selected);
}

function onTextureChange() {
    const val = document.getElementById('textureSelect').value;
    document.getElementById('textureURLLabel').style.display = (val === 'custom') ? 'block' : 'none';
}

function addObject() {
    const modelUrl = document.getElementById("modelSelect").value;
    const modelName = document.getElementById("submodelSelect").value;

    const obj = {
        type: "box"
    };

    if (modelUrl && modelName) {
        obj.file = modelUrl;
        obj.model = modelName;
    }
    else {
        obj.position = { x: 0, y: 0, z: 0 };
        obj.size = [4, 1, 4];
        obj.color = "#888888";
    }

    createMapObject(obj, true).then(selectObject);
}

function deleteObject() {
    if (!selected) return;
    if (selected.__highlightMesh) {
        scene.remove(selected.__highlightMesh);
    }
    scene.remove(selected);
    selected = null;
}

function exportMap() {
    const objects = [];
    const octreeObjects = [];

    // First gather the objects to export
    scene.children.forEach(obj => {
        if (!obj.userData.isEditable) return;

        // === Object Export ===
        const base = {
            position: {
                x: obj.position.x,
                y: obj.position.y,
                z: obj.position.z,
            },
            size: obj.userData.size || undefined,
            rotation: obj.rotation ? {
                x: THREE.MathUtils.radToDeg(obj.rotation.x),
                y: THREE.MathUtils.radToDeg(obj.rotation.y),
                z: THREE.MathUtils.radToDeg(obj.rotation.z)
            } : undefined,
            scale: obj.scale ? {
                x: obj.scale.x,
                y: obj.scale.y,
                z: obj.scale.z
            } : undefined,
            type: obj.userData.type || 'box',
            color: obj.userData.color,
            texture: obj.userData.texture
        };

        if (obj.userData.file && obj.userData.model) {
            base.file = obj.userData.file;
            base.model = obj.userData.model;
            base.offset = obj.userData.offset;
        }

        objects.push(base);

        // === Prepare for Octree Insertion ===
        obj.updateMatrixWorld(true);

        obj.traverse(child => {
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const flattened = new THREE.Mesh(
                child.geometry.clone(),
                new THREE.MeshBasicMaterial() // dummy material
            );
            flattened.applyMatrix4(child.matrixWorld);
            flattened.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(flattened);
            const center = new THREE.Vector3();
            const size = new THREE.Vector3();
            box.getCenter(center);
            box.getSize(size);

            // Don't assign `Box3` or full `userData` object to flattened directly
            flattened.center = center;
            flattened.size = [size.x, size.y, size.z];

            // Minimal metadata only (avoid direct geometry or box reference)
            flattened.userData = {
                model: child.userData?.model,
                file: child.userData?.file,
                type: child.userData?.type,
            };

            octreeObjects.push(flattened);
        });

    });

    // === Build Octree ===
    const bounds = computeMapBounds(octreeObjects);
    const tempOctree = new OctreeNode(bounds.center, bounds.size * 2);
    tempOctree.mergeDist = 0.5;

    for (const mesh of octreeObjects) {
        tempOctree.insert(mesh);
    }

    const octreeJson = tempOctree.toJSON();
    const newOctree = OctreeNode.fromJSON(octreeJson);
    newOctree.draw(scene);

    const result = JSON.stringify({
        name: "Jump Arena XL",
        objects,
        healthPacks: [],
        octree: octreeJson
    }, null, 2);

    const json = compactVectorObjects(result);

    openOverlay("export", json);
}

function compactVectorObjects(json) {
    const vectorKeys = ['position', 'rotation', 'scale', 'offset', 'center'];

    const vectorRegex = new RegExp(
        `"(${vectorKeys.join('|')})":\\s*\\{\\s*"x":\\s*([^,\\n]+),\\s*"y":\\s*([^,\\n]+),\\s*"z":\\s*([^\\n\\r]+?)\\s*\\}`,
        'g'
    );

    const sizeRegex = /(\s*)"size": \[\s*([^\]]+?)\s*\]/g;

    return json
        .replace(vectorRegex, (_, key, x, y, z) =>
            `"${key}": { "x": ${x.trim()}, "y": ${y.trim()}, "z": ${z.trim()} }`)
        .replace(sizeRegex, (_, indent, values) =>
            `${indent}"size": [ ${values.trim().replace(/\s*,\s*/g, ', ')} ]`);
}

function loadMap() {
    openOverlay("load");
}

function loadMapFromData(data) {
    scene.children.filter(obj => obj.userData.isEditable).forEach(obj => {
        if (obj.__highlightMesh) {
            scene.remove(obj.__highlightMesh);
        }
        scene.remove(obj);
    });

    // If full map object is passed, use its 'objects' field
    const objects = Array.isArray(data) ? data : data.objects;

    if (!Array.isArray(objects)) {
        alert("Invalid map format: 'objects' field is missing or invalid.");
        return;
    }

    objects.forEach(obj => {
        if (!obj.size) return;
        createMapObject(obj, true);
    });
}

function openOverlay(mode, content = "") {
    overlayMode = mode;
    document.getElementById("overlay").style.display = "block";
    document.getElementById("overlayText").value = content;
    document.getElementById("overlayTitle").textContent =
        mode === "export" ? "Exported Map JSON" : "Paste Map JSON to Load";
}

function closeOverlay() {
    document.getElementById("overlay").style.display = "none";
    overlayMode = "";
}

function confirmOverlay() {
    const text = document.getElementById("overlayText").value;
    if (overlayMode === "load") {
        try {
            const json = JSON.parse(text);
            loadMapFromData(json);
            closeOverlay();
        } catch (err) {
            alert("Invalid JSON.");
        }
    } else {
        closeOverlay();
    }
}

function onMouseMove(e) {
    if (e.buttons === 2 || e.buttons === 4) {
        yaw -= e.movementX * 0.002;
        pitch -= e.movementY * 0.002;
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
        e.preventDefault();
    }
}

function updateCameraPosition(delta) {
    const speed = 10 * delta;
    const move = new THREE.Vector3();

    // Full 3D direction — like a plane or noclip camera
    const direction = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const up = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

    if (keys['w']) move.add(direction);
    if (keys['s']) move.sub(direction);
    if (keys['a']) move.sub(right);
    if (keys['d']) move.add(right);
    if (keys[' ']) move.add(up);        // Space to fly upward
    if (keys['shift']) move.sub(up);    // Shift to fly downward

    move.multiplyScalar(speed);
    camera.position.add(move);

    camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = (now - prev) / 1000;
    updateCameraPosition(delta);
    prev = now;
    renderer.render(scene, camera);
    renderAxis();
}