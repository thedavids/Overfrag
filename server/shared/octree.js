import * as THREE from 'three';

export class OctreeNode {
    constructor(center, size, depth = 0, maxDepth = 5, maxObjects = 8, mergeDist = 20) {
        this.center = center; // { x, y, z }
        this.size = size;     // scalar length of cube's edge
        this.depth = depth;
        this.maxDepth = maxDepth;
        this.maxObjects = maxObjects;
        this.mergeDist = mergeDist;

        this.objects = [];
        this.children = null;
        this.once = false;
    }

    getAABB() {
        const half = this.size / 2;
        return {
            min: {
                x: this.center.x - half,
                y: this.center.y - half,
                z: this.center.z - half,
            },
            max: {
                x: this.center.x + half,
                y: this.center.y + half,
                z: this.center.z + half,
            },
        };
    }

    intersects(aabb) {
        const epsilon = 1e-6; // tiny buffer
        const nodeAABB = this.getAABB();
        return !(
            nodeAABB.max.x < aabb.min.x - epsilon || nodeAABB.min.x > aabb.max.x + epsilon ||
            nodeAABB.max.y < aabb.min.y - epsilon || nodeAABB.min.y > aabb.max.y + epsilon ||
            nodeAABB.max.z < aabb.min.z - epsilon || nodeAABB.min.z > aabb.max.z + epsilon
        );
    }

    insert(object, isRoot = true) {

        if (object.isMesh && object.geometry && !object.__processedForOctree) {
            const triangles = this.extractTrianglesFromMesh(object);
            const groups = this.groupTrianglesByProximity(triangles);

            for (const group of groups) {
                const { center, size, box } = this.computeGroupAABB(group);

                // Clone the object
                const clone = object.clone();

                // Inject minimal AABB + metadata for octree
                clone.__processedForOctree = true;
                clone.center = center;
                clone.size = size;
                clone.userData = {
                    ...object.userData,
                    box
                };

                this.insert(clone, false); // Standard octree path
            }

            object.__processedForOctree = true;
            return true; // Skip inserting the original whole mesh
        }

        const objAABB = this.computeObjectAABB(object);
        const rootAABB = this.getAABB();

        const intersecting = this.intersects(objAABB);
        if (!intersecting) {
            if (isRoot) {
                console.warn('ðŸš« INSERT REJECTED (root):', object.name, objAABB, rootAABB, this.size, this.center);
            }
            return false;
        }

        // Subdivide if needed
        if (!this.children && this.objects.length >= this.maxObjects && this.depth < this.maxDepth) {
            this.subdivide();
        }

        // Try inserting into children only if fully contained
        if (this.children) {
            for (const child of this.children) {
                if (this.fullyContains(child.getAABB(), objAABB)) {
                    return child.insert(object, false); // not root anymore
                }
            }
        }

        this.objects.push(object);
        return true;
    }

    fullyContains(container, target) {
        return (
            container.min.x <= target.min.x && container.max.x >= target.max.x &&
            container.min.y <= target.min.y && container.max.y >= target.max.y &&
            container.min.z <= target.min.z && container.max.z >= target.max.z
        );
    }

    subdivide() {
        const half = this.size / 2;
        const quarter = half / 2;

        const offsets = [
            [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
            [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
        ];

        this.children = offsets.map(offset => {
            return new OctreeNode(
                {
                    x: this.center.x + offset[0] * quarter,
                    y: this.center.y + offset[1] * quarter,
                    z: this.center.z + offset[2] * quarter,
                },
                half,
                this.depth + 1,
                this.maxDepth,
                this.maxObjects,
                this.mergeDist
            );
        });

        // Move only fully contained objects into children
        const remaining = [];

        for (const obj of this.objects) {
            const objAABB = this.computeObjectAABB(obj);
            let inserted = false;

            for (const child of this.children) {
                const childAABB = child.getAABB();
                if (this.fullyContains(childAABB, objAABB)) {
                    child.insert(obj, false); // do not recurse as root
                    inserted = true;
                    break;
                }
            }

            if (!inserted) {
                remaining.push(obj); // stay in current node
            }
        }

        this.objects = remaining;
    }

    extractTrianglesFromMesh(mesh) {
        const geometry = mesh.geometry;
        const position = geometry.attributes.position;
        const index = geometry.index;
        const matrixWorld = mesh.matrixWorld;
        const triangles = [];

        if (!index) return triangles;

        for (let i = 0; i < index.count; i += 3) {
            const a = index.getX(i);
            const b = index.getX(i + 1);
            const c = index.getX(i + 2);

            const va = new THREE.Vector3().fromBufferAttribute(position, a).applyMatrix4(matrixWorld);
            const vb = new THREE.Vector3().fromBufferAttribute(position, b).applyMatrix4(matrixWorld);
            const vc = new THREE.Vector3().fromBufferAttribute(position, c).applyMatrix4(matrixWorld);

            triangles.push([va, vb, vc]);
        }

        return triangles;
    }

    groupTrianglesByProximity(triangles) {
        const groups = [];
        const visited = new Set();

        const vertexKey = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;

        // Build a vertex-to-triangle map
        const vertexMap = new Map();
        for (let i = 0; i < triangles.length; i++) {
            const tri = triangles[i];
            for (const v of tri) {
                const key = vertexKey(v);
                if (!vertexMap.has(key)) vertexMap.set(key, []);
                vertexMap.get(key).push(i);
            }
        }

        const dfsIterative = (startIndex, group) => {
            const stack = [startIndex];

            while (stack.length > 0) {
                const i = stack.pop();
                if (visited.has(i)) continue;

                visited.add(i);
                const tri = triangles[i];
                group.push(tri);

                for (const v of tri) {
                    const key = vertexKey(v);
                    const neighbors = vertexMap.get(key) || [];

                    for (const neighborIndex of neighbors) {
                        if (!visited.has(neighborIndex)) {
                            stack.push(neighborIndex);
                        }
                    }
                }
            }
        };

        for (let i = 0; i < triangles.length; i++) {
            if (!visited.has(i)) {
                const group = [];
                dfsIterative(i, group);
                groups.push(group);
            }
        }

        return groups;
    }

    triangleCenter([a, b, c]) {
        return a.clone().add(b).add(c).multiplyScalar(1 / 3);
    }

    computeObjectAABB(obj) {
        const cx = obj.center?.x ?? obj.position.x;
        const cy = obj.center?.y ?? obj.position.y;
        const cz = obj.center?.z ?? obj.position.z;
        const half = {
            x: obj.size[0] / 2,
            y: obj.size[1] / 2,
            z: obj.size[2] / 2,
        };

        return {
            center: [cx, cy, cz],
            size: obj.size,
            min: { x: cx - half.x, y: cy - half.y, z: cz - half.z },
            max: { x: cx + half.x, y: cy + half.y, z: cz + half.z },
        };
    }

    intersectsAABB(a, b) {
        return !(
            a.max.x <= b.min.x || a.min.x >= b.max.x ||
            a.max.y <= b.min.y || a.min.y >= b.max.y ||
            a.max.z <= b.min.z || a.min.z >= b.max.z
        );
    }

    computeGroupAABB(triangles) {
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

        for (const [a, b, c] of triangles) {
            min.min(a).min(b).min(c);
            max.max(a).max(b).max(c);
        }

        const size = new THREE.Vector3().subVectors(max, min);
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);

        return {
            center,
            size: [size.x, size.y, size.z],
            box: { min, max }
        };
    }

    queryRange(range, result = [], filterFn = null, padding = 1.5, _alreadyPadded = false) {
        const queryBox = _alreadyPadded
            ? range
            : {
                min: {
                    x: range.min.x - padding,
                    y: range.min.y - padding,
                    z: range.min.z - padding
                },
                max: {
                    x: range.max.x + padding,
                    y: range.max.y + padding,
                    z: range.max.z + padding
                }
            };

        if (!this.intersects(queryBox)) return result;
        if (this.objects.length === 0 && !this.children) return result;

        for (const obj of this.objects) {
            const objAABB = this.computeObjectAABB(obj);
            if (typeof obj.name === 'string' && obj.name.indexOf('ground') !== -1) {
                if (!this.once) {

                    console.log(queryBox, objAABB);
                    this.once = true;
                }
            }
            if (this.intersectsAABB(objAABB, queryBox)) {
                if (!filterFn || filterFn(obj)) {
                    result.push(obj);
                }
            }
        }

        if (this.children) {
            for (const child of this.children) {
                child.queryRange(queryBox, result, filterFn, padding, true);
            }
        }

        return result;
    }

    queryCapsule(capsule, result = [], filterFn = null) {
        const start = performance.now();
        const r = capsule.radius;
        const padding = 0.5; // small epsilon to catch borderline overlaps

        const capsuleAABB = {
            min: {
                x: Math.min(capsule.start.x, capsule.end.x) - r - padding,
                y: Math.min(capsule.start.y, capsule.end.y) - r - padding,
                z: Math.min(capsule.start.z, capsule.end.z) - r - padding,
            },
            max: {
                x: Math.max(capsule.start.x, capsule.end.x) + r + padding,
                y: Math.max(capsule.start.y, capsule.end.y) + r + padding,
                z: Math.max(capsule.start.z, capsule.end.z) + r + padding,
            }
        };

        const query = this.queryRange(capsuleAABB, result, filterFn);
        const end = performance.now();
        if (end - start > 5) {
            console.warn(`queryCapsule: ${(end - start).toFixed(2)} ms`);
        }
        return query;
    }

    queryRay(origin, direction, maxDist, result = [], filterFn = null) {
        const start = performance.now();
        const end = {
            x: origin.x + direction.x * maxDist,
            y: origin.y + direction.y * maxDist,
            z: origin.z + direction.z * maxDist
        };

        const range = {
            min: {
                x: Math.min(origin.x, end.x),
                y: Math.min(origin.y, end.y),
                z: Math.min(origin.z, end.z)
            },
            max: {
                x: Math.max(origin.x, end.x),
                y: Math.max(origin.y, end.y),
                z: Math.max(origin.z, end.z)
            }
        };

        const query = this.queryRange(range, result, filterFn);
        const timeEnd = performance.now();
        if (timeEnd - start > 5) {
            console.warn(`queryRay: ${(timeEnd - start).toFixed(2)} ms`);
        }
        return query;
    }

    querySphere(center, radius, result = [], filterFn = null) {
        const range = {
            min: {
                x: center.x - radius,
                y: center.y - radius,
                z: center.z - radius
            },
            max: {
                x: center.x + radius,
                y: center.y + radius,
                z: center.z + radius
            }
        };
        return this.queryRange(range, result, filterFn);
    }

    exportCollidersFromOctree() {
        const colliders = [];

        function traverse(node) {
            for (const obj of node.objects) {
                if (!obj.center || !obj.size) continue;

                const [sx, sy, sz] = obj.size;
                const volume = sx * sy * sz;
                const minVolume = 0.01;

                //if (volume >= minVolume) {

                colliders.push({
                    center: {
                        x: obj.center.x,
                        y: obj.center.y,
                        z: obj.center.z
                    },
                    size: [...obj.size],
                    type: obj.userData?.type || 'box',
                    name: obj.name || undefined,
                    model: obj.userData?.model,
                    file: obj.userData?.file,
                    offset: obj.userData?.offset
                });
                //}
            }

            if (node.children) {
                for (const child of node.children) {
                    traverse(child);
                }
            }
        }

        traverse(this);
        return colliders;
    }

    count() {
        let total = this.objects.length;

        if (this.children) {
            for (const child of this.children) {
                total += child.count();
            }
        }

        return total;
    }

    erase(scene) {
        const toRemove = scene.children.filter(obj => obj.userData?.isOctree === true);
        for (const obj of toRemove) {
            scene.remove(obj);
            obj.geometry?.dispose();
            obj.material?.dispose();
        }
    }

    draw(scene) {
        this.erase(scene);
        // === Export Colliders from Octree ===
        const colliders = this.exportCollidersFromOctree();
        for (const collider of colliders) {
            // Visual helper
            const geom = new THREE.BoxGeometry(...collider.size);
            const edges = new THREE.EdgesGeometry(geom); // <- extract only box edges
            const line = new THREE.LineSegments(
                edges,
                new THREE.LineBasicMaterial({ color: 0x00ff00 })
            );

            line.position.set(collider.center.x, collider.center.y, collider.center.z);
            line.name = `OctreeColliderBox_${Math.random()}`;
            line.userData.isOctree = true;
            scene.add(line);
        }
    }

    toJSON() {
        return {
            center: this.center,
            size: this.size,
            depth: this.depth,
            maxDepth: this.maxDepth,
            maxObjects: this.maxObjects,
            objects: this.objects.map(obj => ({
                name: obj.name || undefined,
                center: obj.center,
                size: obj.size,
                userData: (obj.userData?.file != null || obj.userData?.model != null || obj.userData?.offset != null) ?
                    {
                        file: obj.userData?.file,
                        model: obj.userData?.model,
                        offset: obj.userData?.offset
                    } :
                    undefined
            })),
            children: this.children ? this.children.map(child => child.toJSON()) : null
        };
    }

    static fromJSON(data) {
        const node = new OctreeNode(data.center, data.size, data.depth, data.maxDepth, data.maxObjects);
        node.objects = data.objects.map(o => {
            const mesh = {};
            mesh.name = o.name || '';
            mesh.center = o.center;
            mesh.size = o.size;
            mesh.userData = { ...o.userData };
            mesh.userData.box = {
                min: {
                    x: o.center.x - o.size[0] / 2,
                    y: o.center.y - o.size[1] / 2,
                    z: o.center.z - o.size[2] / 2
                },
                max: {
                    x: o.center.x + o.size[0] / 2,
                    y: o.center.y + o.size[1] / 2,
                    z: o.center.z + o.size[2] / 2
                }
            };
            return mesh;
        });
        if (data.children) {
            node.children = data.children.map(OctreeNode.fromJSON);
        }
        return node;
    }
}

export function computeMapBounds(objects) {
    let min = { x: Infinity, y: Infinity, z: Infinity };
    let max = { x: -Infinity, y: -Infinity, z: -Infinity };

    for (const obj of objects) {
        const size = obj.size;
        const pos = (obj.center && typeof obj.center.x === 'number') ? obj.center : obj.position;

        const half = {
            x: size[0] / 2,
            y: size[1] / 2,
            z: size[2] / 2
        };

        const objMin = {
            x: pos.x - half.x,
            y: pos.y - half.y,
            z: pos.z - half.z
        };

        const objMax = {
            x: pos.x + half.x,
            y: pos.y + half.y,
            z: pos.z + half.z
        };

        min.x = Math.min(min.x, objMin.x);
        min.y = Math.min(min.y, objMin.y);
        min.z = Math.min(min.z, objMin.z);

        max.x = Math.max(max.x, objMax.x);
        max.y = Math.max(max.y, objMax.y);
        max.z = Math.max(max.z, objMax.z);
    }

    // Final center of the entire scene
    const center = {
        x: (min.x + max.x) / 2,
        y: (min.y + max.y) / 2,
        z: (min.z + max.z) / 2
    };

    // Cube size large enough to contain the whole scene + margin
    const padding = 10;
    const spanX = max.x - min.x + 2 * padding;
    const spanY = max.y - min.y + 2 * padding;
    const spanZ = max.z - min.z + 2 * padding;

    const size = Math.max(spanX, spanY, spanZ);

    return { center, size };
}
