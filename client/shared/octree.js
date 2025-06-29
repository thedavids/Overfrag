import * as THREE from 'three';

export class OctreeNode {
    constructor(center, size, depth = 0, maxDepth = 5, maxObjects = 8) {
        this.center = center; // { x, y, z }
        this.size = size;     // scalar length of cube's edge
        this.depth = depth;
        this.maxDepth = maxDepth;
        this.maxObjects = maxObjects;

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
            const groups = this.groupTrianglesByProximity(triangles, 20.0);

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
                    box,
                    __triangles: group // for precise collision if needed
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
                this.maxObjects
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

    groupTrianglesByProximity(triangles, mergeDist) {
        const grid = new Map();
        const groups = [];
        const bucketSize = mergeDist;

        const getKey = (v) => {
            const xi = Math.floor(v.x / bucketSize);
            const yi = Math.floor(v.y / bucketSize);
            const zi = Math.floor(v.z / bucketSize);
            return `${xi},${yi},${zi}`;
        };

        const offsets = [-1, 0, 1];

        for (const tri of triangles) {
            const center = this.triangleCenter(tri);
            const key = getKey(center);

            let added = false;

            // Search neighboring buckets for nearby groups
            for (const dx of offsets) {
                for (const dy of offsets) {
                    for (const dz of offsets) {
                        const neighborKey = getKey({
                            x: center.x + dx * bucketSize,
                            y: center.y + dy * bucketSize,
                            z: center.z + dz * bucketSize
                        });

                        const bucketGroups = grid.get(neighborKey);
                        if (bucketGroups) {
                            for (const group of bucketGroups) {
                                if (group.some(t => this.triangleCenter(t).distanceTo(center) <= mergeDist)) {
                                    group.push(tri);
                                    added = true;
                                    break;
                                }
                            }
                            if (added) break;
                        }
                    }
                    if (added) break;
                }
                if (added) break;
            }

            if (!added) {
                const newGroup = [tri];
                groups.push(newGroup);
                const bucket = grid.get(key) || [];
                bucket.push(newGroup);
                grid.set(key, bucket);
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

        return this.queryRange(capsuleAABB, result, filterFn);
    }

    queryRay(origin, direction, maxDist, result = [], filterFn = null) {
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

        return this.queryRange(range, result, filterFn);
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
