import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import * as MathUtils from './math-utils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const maps = {
    anotherCity: { "name": "Detailed City" },
    default: { "name": "Jump Arena" },
    city: { "name": "City" },
    giganticCity: { "name": "Gigantic City" },
    blockTown: { "name": "Block Town" }
};

export function getAvailableMaps() {
    const availableMaps = Object.entries(maps).map(([id, map]) => ({
        id,
        name: map?.name || id
    }));
    return availableMaps;
}

export async function loadMap(name = "default") {
    try {
        const filePath = path.join(__dirname, 'maps', `${name}.json`);
        const fileData = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(fileData);
    } catch (err) {
        console.error(`❌ Failed to load map '${name}':`, err.message);
        return null;
    }
}

export async function prepareMap(name) {
    const map = await loadMap(name);

    if (map.bvh && Array.isArray(map.bvh)) {
        const allGeometries = map.bvh.map(part => {
            const geometry = new THREE.BufferGeometry();

            // === Position ===
            const posBuffer = MathUtils.base64ToArrayBuffer(part.position);
            const posArray = new Float32Array(posBuffer, 0, part.count * 3);
            const posAttr = new THREE.Float32BufferAttribute(posArray, 3);
            geometry.setAttribute('position', posAttr);

            // === Index (if any) ===
            if (part.index) {
                const idxBuffer = MathUtils.base64ToArrayBuffer(part.index);
                const IndexArrayType = (part.indexType === 'Uint16Array') ? Uint16Array : Uint32Array;

                const expectedBytes = part.indexCount * IndexArrayType.BYTES_PER_ELEMENT;
                if (idxBuffer.byteLength < expectedBytes) {
                    console.warn('⚠️ Index buffer too small:', {
                        expected: expectedBytes,
                        actual: idxBuffer.byteLength,
                        part
                    });
                    return null;
                }

                const idxArray = new IndexArrayType(idxBuffer, 0, part.indexCount);
                geometry.setIndex(new THREE.BufferAttribute(idxArray, 1));
            }

            return geometry;
        }).filter(Boolean);
        const mergedGeometry = mergeGeometries(allGeometries, false);
        mergedGeometry.boundsTree = new MeshBVH(mergedGeometry);

        map.bvhMesh = mergedGeometry;
    }

    return map;
}

export function toClientMap(map) {
    const mapToSend = { ...map };
    delete mapToSend.bvh;
    delete mapToSend.bvhMesh;
    return mapToSend;
}